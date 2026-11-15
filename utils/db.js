// 宝物数据层（WorkBuddy 云端实现）。
// 原则：
// - 浏览（listBuried/get/nearby）走公开读，匿名可用
// - 插入走 RLS（owner_id 由服务端 DEFAULT auth.uid() 填充，前端不传）
// - 带走 / 追加提示走服务端原子 RPC（take_treasure / add_treasure_hint），
//   抢宝冲突由数据库单条 UPDATE 裁决，客户端无 UPDATE 权限，天然防作弊
// - 写库（rpc 返回 ok:true）成功后页面才允许改 UI
// - 坐标全程 GCJ-02，不做二次转换
var config = require('./config');
var geo = require('./geo');
var cloudMod = require('./cloud');
var auth = require('./auth');

var cloud = cloudMod.cloud;

// 云行 → 页面使用的 camelCase 形状（时间戳为 ISO 字符串，relTime 已兼容）
function toRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        name: r.name,
        riddle: r.riddle,
        hints: Array.isArray(r.hints) ? r.hints : [],
        status: r.status,
        lng: r.lng,
        lat: r.lat,
        photoPath: r.photo_path || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        creatorUid: r.owner_id,
        takenBy: r.taken_by || ''
    };
}

// 仅返回埋藏中的宝物（taken 对全端不可见）
function listBuried() {
    return cloud.database
        .from('treasures')
        .select('id, name, riddle, hints, status, lng, lat, photo_path, owner_id, taken_by, created_at, updated_at')
        .eq('status', 'buried')
        .order('created_at', { ascending: false })
        .limit(200)
        .then(function (r) {
            if (r.error) {
                console.error('[WorkBuddy Cloud] db listBuried failed', r.error.message);
                return [];
            }
            return (r.data || []).map(toRow);
        })
        .catch(function () { return []; });
}

function get(id) {
    var numId = Number(id);
    if (!isFinite(numId)) return Promise.resolve(null);
    return cloud.database
        .from('treasures')
        .select('id, name, riddle, hints, status, lng, lat, photo_path, owner_id, taken_by, created_at, updated_at')
        .eq('id', numId)
        .maybeSingle()
        .then(function (r) {
            if (r.error) {
                console.error('[WorkBuddy Cloud] db get failed', r.error.message);
                return null;
            }
            return toRow(r.data);
        })
        .catch(function () { return null; });
}

// 插入前必须已登录（RLS 要求 owner_id = auth.uid()）
function insert(rec) {
    return auth.ensureLogin().then(function (session) {
        if (!session) {
            return { err: '未登录，无法藏宝' };
        }
        return cloud.database
            .from('treasures')
            .insert({
                name: rec.name,
                riddle: rec.riddle,
                lng: rec.lng,
                lat: rec.lat,
                photo_path: rec.photoPath || '',
                owner_name: (session.user && session.user.name) || null,
                hints: []
            })
            .select()
            .then(function (r) {
                if (r.error) {
                    console.error('[WorkBuddy Cloud] db insert failed', r.error.message);
                    return { err: friendlyDbError(r.error) };
                }
                var rows = r.data || [];
                if (!rows.length) {
                    return { err: '提交失败，请重试' };
                }
                return toRow(rows[0]);
            })
            .catch(function (e) {
                return { err: '网络异常，提交失败' };
            });
    });
}

// 带走：服务端原子判定，已被他人带走返回 { ok:false, reason:'gone' }
function markTaken(id) {
    return rpc('take_treasure', { p_id: Number(id) });
}

// 继续埋藏：追加一条提示，状态保持 buried
function addHint(id, hint) {
    return rpc('add_treasure_hint', { p_id: Number(id), p_hint: hint });
}

function rpc(fnName, args) {
    return cloud.database
        .rpc(fnName, args)
        .then(function (r) {
            if (r.error) {
                console.error('[WorkBuddy Cloud] rpc ' + fnName + ' failed', r.error.message);
                return { ok: false, reason: 'error', msg: friendlyDbError(r.error) };
            }
            var d = r.data;
            if (d && typeof d.ok === 'boolean') {
                return d;
            }
            return { ok: false, reason: 'error', msg: '服务返回异常，请重试' };
        })
        .catch(function () {
            return { ok: false, reason: 'error', msg: '网络异常，请重试' };
        });
}

// 附近查询：拉一次列表后前端精筛（v1 宝物数 <200 够用；翻页与空间索引留待 v2）
function nearby(player, radius) {
    return listBuried().then(function (list) {
        return list
            .map(function (t) {
                return { treasure: t, distance: geo.dist(player, [t.lng, t.lat]) };
            })
            .filter(function (n) {
                return n.distance <= radius;
            })
            .sort(function (a, b) {
                return a.distance - b.distance;
            });
    });
}

/* ---------- 照片上云（shared 目录，跨用户可见） ---------- */

// 上传现场照：localPath 为本机文件路径，返回存储对象路径或 { err }
// 实现说明：SDK 小程序适配器当前不支持二进制请求 body（ArrayBuffer 抛「待补」），
// 因此采用 SDK 签发签名上传 URL（token 在 URL 内授权，无需 SDK 注入凭证），
// 二进制内容走微信原生 wx.uploadFile 多部分上传通道。
// err 里带上真实错误码/信息，方便真机排查（域名白名单 / 权限 / 网络）
function uploadPhoto(localPath, session) {
    return new Promise(function (resolve) {
        var uid = session && session.user && session.user.id ? session.user.id : '';
        if (!uid) {
            resolve({ err: '未登录，无法上传照片' });
            return;
        }
        var path = cloud.storage.sharedPath(uid, 'treasures/' + Date.now() + '.jpg');
        cloud.storage.createSignedUploadUrl(path).then(function (signed) {
            if (signed.error || !signed.data || !signed.data.signedUrl) {
                console.error('[WorkBuddy Cloud] sign upload url failed', JSON.stringify({
                    stage: 'storage-sign',
                    code: signed.error && signed.error.code || '',
                    message: signed.error && signed.error.message || ''
                }));
                resolve({ err: '照片上传失败 ' + ((signed.error && signed.error.message) || '').slice(0, 80) });
                return;
            }
            wx.uploadFile({
                url: signed.data.signedUrl,
                filePath: localPath,
                name: 'file',
                formData: { cacheControl: '3600' },
                success: function (res) {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ path: path });
                    } else {
                        console.error('[WorkBuddy Cloud] photo upload failed', JSON.stringify({
                            stage: 'wx.uploadFile',
                            status: res.statusCode,
                            body: String(res.data || '').slice(0, 200)
                        }));
                        resolve({ err: '照片上传失败 HTTP ' + res.statusCode });
                    }
                },
                fail: function (err) {
                    console.error('[WorkBuddy Cloud] photo upload failed', JSON.stringify({
                        stage: 'wx.uploadFile',
                        message: err && err.errMsg ? err.errMsg : 'uploadFile failed'
                    }));
                    resolve({ err: '照片上传失败 ' + (err && err.errMsg ? err.errMsg : '') });
                }
            });
        }).catch(function (e) {
            console.error('[WorkBuddy Cloud] photo sign threw', JSON.stringify({
                stage: 'storage-sign',
                message: e && e.message ? e.message : String(e)
            }));
            resolve({ err: '照片上传失败 ' + ((e && e.message) ? e.message : String(e)).slice(0, 80) });
        });
    });
}

// 取现场照的临时访问链接（需登录，链接短时有效）
function photoUrl(storagePath) {
    if (!storagePath) return Promise.resolve('');
    return cloud.storage.createSignedUrl(storagePath, 1800)
        .then(function (r) {
            if (r.error || !r.data) return '';
            return r.data.url || '';
        })
        .catch(function () { return ''; });
}

// 数据库错误 → 用户可读文案
function friendlyDbError(err) {
    var code = err && err.code;
    if (code === '42501') return '没有权限，请先登录后重试';
    if (code === '42P01') return '后台数据表尚未就绪';
    if (code === '23505') return '记录已存在';
    return (err && err.message) ? '操作失败：' + err.message : '操作失败，请重试';
}

module.exports = {
    listBuried: listBuried,
    get: get,
    insert: insert,
    markTaken: markTaken,
    addHint: addHint,
    nearby: nearby,
    uploadPhoto: uploadPhoto,
    photoUrl: photoUrl
};
