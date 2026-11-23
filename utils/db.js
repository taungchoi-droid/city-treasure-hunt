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

/* ---------- 收藏（仅本人可见，RLS 限定 owner_id） ---------- */

// 收藏 / 取消收藏：返回 { ok, favorited } 或 { err }
// 先查后写，天然幂等；唯一约束兜底并发重复收藏
function toggleFavorite(treasureId) {
    var numId = Number(treasureId);
    if (!isFinite(numId)) return Promise.resolve({ err: '宝物参数异常' });
    return auth.ensureLogin().then(function (session) {
        if (!session) {
            return { err: '未登录，无法收藏' };
        }
        return cloud.database
            .from('favorites')
            .select('id')
            .eq('treasure_id', numId)
            .limit(1)
            .then(function (r) {
                if (r.error) {
                    console.error('[WorkBuddy Cloud] db favorite query failed', r.error.message);
                    return { err: friendlyDbError(r.error) };
                }
                var rows = r.data || [];
                if (rows.length) {
                    return cloud.database
                        .from('favorites')
                        .delete()
                        .eq('id', rows[0].id)
                        .then(function (d) {
                            if (d.error) {
                                console.error('[WorkBuddy Cloud] db unfavorite failed', d.error.message);
                                return { err: friendlyDbError(d.error) };
                            }
                            return { ok: true, favorited: false };
                        });
                }
                return cloud.database
                    .from('favorites')
                    .insert({ treasure_id: numId })
                    .then(function (i) {
                        if (i.error) {
                            // 23505 = 并发下已被另一请求收藏，按"已收藏"处理
                            if (i.error.code === '23505') return { ok: true, favorited: true };
                            console.error('[WorkBuddy Cloud] db favorite insert failed', i.error.message);
                            return { err: friendlyDbError(i.error) };
                        }
                        return { ok: true, favorited: true };
                    });
            });
    }).catch(function () {
        return { err: '网络异常，操作失败' };
    });
}

// 当前用户是否已收藏该宝物（未登录直接 false，不请求）
function isFavorite(treasureId) {
    var numId = Number(treasureId);
    if (!isFinite(numId)) return Promise.resolve(false);
    return auth.getSession().then(function (session) {
        if (!session) return false;
        return cloud.database
            .from('favorites')
            .select('id')
            .eq('treasure_id', numId)
            .limit(1)
            .then(function (r) {
                if (r.error || !r.data) return false;
                return r.data.length > 0;
            })
            .catch(function () { return false; });
    }).catch(function () { return false; });
}

// 我的收藏列表：favorites 只存 id，宝物详情二次查询并关联状态
// taken 状态不隐藏——保留在列表里并标记「已被带走」（用户可自行取消收藏）
function listFavorites() {
    return auth.ensureLogin().then(function (session) {
        if (!session) return { needLogin: true, list: [] };
        return cloud.database
            .from('favorites')
            .select('id, treasure_id, created_at')
            .order('created_at', { ascending: false })
            .limit(100)
            .then(function (r) {
                if (r.error) {
                    console.error('[WorkBuddy Cloud] db listFavorites failed', r.error.message);
                    return { list: [], err: friendlyDbError(r.error) };
                }
                var favs = r.data || [];
                if (!favs.length) return { list: [] };
                var ids = favs.map(function (f) { return f.treasure_id; });
                return cloud.database
                    .from('treasures')
                    .select('id, name, status, lng, lat')
                    .in('id', ids)
                    .then(function (t) {
                        if (t.error) {
                            console.error('[WorkBuddy Cloud] db favorites treasures failed', t.error.message);
                            return { list: [], err: friendlyDbError(t.error) };
                        }
                        var byId = {};
                        (t.data || []).forEach(function (x) { byId[x.id] = x; });
                        var list = [];
                        favs.forEach(function (f) {
                            var row = byId[f.treasure_id];
                            if (!row) return; // 宝物已被物理删除（ON DELETE CASCADE 理论上会带走收藏，兜底跳过）
                            list.push({
                                id: row.id,
                                name: row.name,
                                status: row.status,
                                lng: row.lng,
                                lat: row.lat,
                                favoritedAt: f.created_at
                            });
                        });
                        return { list: list };
                    });
            });
    }).catch(function () {
        return { list: [], err: '网络异常，加载失败' };
    });
}

// 我带走过的宝物（taken_by = 我，按带走时间倒序）
function listTaken() {
    return auth.ensureLogin().then(function (session) {
        if (!session) return { needLogin: true, list: [] };
        var uid = session.user && session.user.id ? session.user.id : '';
        if (!uid) return { list: [] };
        return cloud.database
            .from('treasures')
            .select('id, name, riddle, hints, status, lng, lat, photo_path, owner_id, taken_by, created_at, updated_at')
            .eq('taken_by', uid)
            .order('updated_at', { ascending: false })
            .limit(100)
            .then(function (r) {
                if (r.error) {
                    console.error('[WorkBuddy Cloud] db listTaken failed', r.error.message);
                    return { list: [], err: friendlyDbError(r.error) };
                }
                return { list: (r.data || []).map(toRow) };
            });
    }).catch(function () {
        return { list: [], err: '网络异常，加载失败' };
    });
}

// 我埋下的宝物（owner_id = 我，含已被别人带走的，按埋藏时间倒序）
function listMyBuried() {
    return auth.ensureLogin().then(function (session) {
        if (!session || !session.user) return { needLogin: true, list: [] };
        return cloud.database
            .from('treasures')
            .select('id, name, status, lng, lat, created_at, updated_at')
            .eq('owner_id', session.user.id)
            .order('created_at', { ascending: false })
            .limit(100)
            .then(function (r) {
                if (r.error) {
                    console.error('[WorkBuddy Cloud] db listMyBuried failed', r.error.message);
                    return { list: [], err: friendlyDbError(r.error) };
                }
                return {
                    list: (r.data || []).map(function (x) {
                        return {
                            id: x.id,
                            name: x.name,
                            status: x.status,
                            lng: x.lng,
                            lat: x.lat,
                            createdAt: x.created_at,
                            updatedAt: x.updated_at
                        };
                    })
                };
            });
    }).catch(function () {
        return { list: [], err: '网络异常，加载失败' };
    });
}

// 我埋下的宝物数量（个人中心统计用，只取 id 不取内容）
function countMyBuried() {
    return auth.getSession().then(function (session) {
        if (!session || !session.user || !session.user.id) return 0;
        return cloud.database
            .from('treasures')
            .select('id')
            .eq('owner_id', session.user.id)
            .limit(200)
            .then(function (r) {
                if (r.error || !r.data) return 0;
                return r.data.length;
            })
            .catch(function () { return 0; });
    }).catch(function () { return 0; });
}

/* ---------- 照片上云（shared 目录，跨用户可见） ---------- */

// 上传图片到 shared 云存储：localPath 为本机文件路径，folder 为目录前缀
// 返回存储对象路径 { path } 或 { err }
// 实现说明：SDK 小程序适配器当前不支持二进制请求 body（ArrayBuffer 抛「待补」），
// 因此采用 SDK 签发签名上传 URL（token 在 URL 内授权，无需 SDK 注入凭证），
// 二进制内容走微信原生 wx.uploadFile 多部分上传通道。
// err 里带上真实错误码/信息，方便真机排查（域名白名单 / 权限 / 网络）
function uploadToShared(localPath, session, folder, label) {
    label = label || '照片';
    return new Promise(function (resolve) {
        var uid = session && session.user && session.user.id ? session.user.id : '';
        if (!uid) {
            resolve({ err: '未登录，无法上传' + label });
            return;
        }
        var path = cloud.storage.sharedPath(uid, folder + Date.now() + '.jpg');
        cloud.storage.createSignedUploadUrl(path).then(function (signed) {
            if (signed.error || !signed.data || !signed.data.signedUrl) {
                console.error('[WorkBuddy Cloud] sign upload url failed', JSON.stringify({
                    stage: 'storage-sign',
                    code: signed.error && signed.error.code || '',
                    message: signed.error && signed.error.message || ''
                }));
                resolve({ err: label + '上传失败 ' + ((signed.error && signed.error.message) || '').slice(0, 80) });
                return;
            }
            wx.uploadFile({
                url: signed.data.signedUrl,
                filePath: localPath,
                name: 'file',
                // wx.uploadFile 绕过了 SDK 请求层，必须手动带上与 SDK 相同的鉴权头：
                // 应用标识（publishableKey）+ 当前会话 token，否则网关返回 401 MISSING_CREDENTIALS
                header: {
                    'x-wb-webapp-access-key': cloudMod.publicConfig.publishableKey,
                    'Authorization': 'Bearer ' + session.accessToken
                },
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
                        resolve({ err: label + '上传失败 HTTP ' + res.statusCode });
                    }
                },
                fail: function (err) {
                    console.error('[WorkBuddy Cloud] photo upload failed', JSON.stringify({
                        stage: 'wx.uploadFile',
                        message: err && err.errMsg ? err.errMsg : 'uploadFile failed'
                    }));
                    resolve({ err: label + '上传失败 ' + (err && err.errMsg ? err.errMsg : '') });
                }
            });
        }).catch(function (e) {
            console.error('[WorkBuddy Cloud] photo sign threw', JSON.stringify({
                stage: 'storage-sign',
                message: e && e.message ? e.message : String(e)
            }));
            resolve({ err: label + '上传失败 ' + ((e && e.message) ? e.message : String(e)).slice(0, 80) });
        });
    });
}

// 现场照：存入 shared/treasures/
function uploadPhoto(localPath, session) {
    return uploadToShared(localPath, session, 'treasures/', '照片');
}

// 头像：存入 shared/avatars/
function uploadAvatar(localPath, session) {
    return uploadToShared(localPath, session, 'avatars/', '头像');
}

// 云存储图片的临时访问链接（需登录，链接短时有效）
// 20 分钟内复用，避免详情页轮询反复签名；对象路径带时间戳，换图即换 key
var urlCache = {};

function photoUrl(storagePath) {
    if (!storagePath) return Promise.resolve('');
    var hit = urlCache[storagePath];
    if (hit && hit.exp > Date.now()) return Promise.resolve(hit.url);
    return cloud.storage.createSignedUrl(storagePath, 1800)
        .then(function (r) {
            if (r.error) {
                console.error('[WorkBuddy Cloud] sign url failed', r.error.message);
                return '';
            }
            if (!r.data) return '';
            // SDK 返回字段是 signedUrl（不是 url）；兼容旧字段写法
            var url = r.data.signedUrl || r.data.url || '';
            if (url) urlCache[storagePath] = { url: url, exp: Date.now() + 20 * 60 * 1000 };
            return url;
        })
        .catch(function () { return ''; });
}

/* ---------- 用户资料（昵称 / 头像；所有人可读，仅本人可写） ---------- */

// 当前用户资料：优先 profiles 表，缺省回退登录态里的微信昵称/头像
// 返回 { nickname, avatarPath, avatarUrl }，未登录返回 null
function getMyProfile() {
    return auth.getSession().then(function (session) {
        if (!session || !session.user) return null;
        var uid = session.user.id;
        var fallbackName = session.user.name || '';
        var fallbackAvatar = session.user.avatarUrl || '';
        return cloud.database
            .from('profiles')
            .select('user_id, nickname, avatar_path')
            .eq('user_id', uid)
            .maybeSingle()
            .then(function (r) {
                var row = (!r.error && r.data) ? r.data : null;
                var nickname = (row && row.nickname) || fallbackName;
                var avatarPath = (row && row.avatar_path) || '';
                if (!avatarPath) {
                    return { nickname: nickname, avatarPath: '', avatarUrl: fallbackAvatar };
                }
                return photoUrl(avatarPath).then(function (url) {
                    return { nickname: nickname, avatarPath: avatarPath, avatarUrl: url || '' };
                });
            });
    }).catch(function () { return null; });
}

// 保存资料：upsert 按 user_id 合并（只更新传入字段）；RLS 保证只能写自己
function saveProfile(patch) {
    return auth.ensureLogin().then(function (session) {
        if (!session || !session.user) return { err: '未登录，无法保存资料' };
        var values = { user_id: session.user.id, updated_at: new Date().toISOString() };
        if (patch && typeof patch.nickname === 'string') values.nickname = patch.nickname;
        if (patch && typeof patch.avatarPath === 'string') values.avatar_path = patch.avatarPath;
        return cloud.database
            .from('profiles')
            .upsert(values, { onConflict: 'user_id' })
            .then(function (w) {
                if (w.error) {
                    console.error('[WorkBuddy Cloud] db profile save failed', w.error.message);
                    return { err: friendlyDbError(w.error) };
                }
                return { ok: true };
            });
    }).catch(function () {
        return { err: '网络异常，保存失败' };
    });
}

// 评论作者：按 hints 里的 by（uid）批量取昵称与头像，返回 uid → { name, avatarUrl }
// cache 可复用已有结果（详情页 12 秒轮询时只查新增作者）
// 查不到资料（历史数据 / 未设置）由页面回退「寻宝人」+ 首字占位
function hintAuthors(hints, cache) {
    cache = cache || {};
    var uids = [];
    (hints || []).forEach(function (h) {
        if (h && h.by && !cache[h.by] && uids.indexOf(h.by) < 0) uids.push(h.by);
    });
    if (!uids.length) return Promise.resolve(cache);
    return cloud.database
        .from('profiles')
        .select('user_id, nickname, avatar_path')
        .in('user_id', uids)
        .then(function (r) {
            if (r.error || !r.data) return cache;
            var tasks = r.data.map(function (row) {
                return photoUrl(row.avatar_path).then(function (url) {
                    return { uid: row.user_id, name: row.nickname || '寻宝人', avatarUrl: url || '' };
                });
            });
            return Promise.all(tasks).then(function (list) {
                list.forEach(function (x) { cache[x.uid] = x; });
                return cache;
            });
        })
        .catch(function () { return cache; });
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
    toggleFavorite: toggleFavorite,
    isFavorite: isFavorite,
    listFavorites: listFavorites,
    listTaken: listTaken,
    listMyBuried: listMyBuried,
    countMyBuried: countMyBuried,
    uploadPhoto: uploadPhoto,
    uploadAvatar: uploadAvatar,
    photoUrl: photoUrl,
    getMyProfile: getMyProfile,
    saveProfile: saveProfile,
    hintAuthors: hintAuthors
};
