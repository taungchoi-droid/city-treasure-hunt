// 宝物详情：谜题 + 提示列表 + 两个按距离解锁的操作按钮
// 云端版规则：
// - 「我已带走」必须服务端 RPC 成功后才改 UI；抢宝冲突由数据库原子裁决
// - 定时器用缓存算距离，每 12 秒向云端重拉一次状态，处理"已被别人带走"
// - 现场照存 shared 云存储，登录后用短时签名链接展示
var config = require('../../utils/config');
var db = require('../../utils/db');
var geo = require('../../utils/geo');
var sec = require('../../utils/sec');
var auth = require('../../utils/auth');
var share = require('../../utils/share');

var app = getApp();

Page({
    data: {
        id: '',
        treasure: null,
        photoUrl: '',
        needLogin: false,    // 有现场照但未登录
        distText: '',
        inRange: false,      // 是否进入核销半径
        positionReady: false,
        hintInput: '',
        hintSending: false,
        taking: false,
        favorited: false,     // 是否已收藏（未登录时仅展示，点击会先登录）
        favBusy: false
    },

    onLoad: function (options) {
        share.enable(false);
        this.setData({ id: options.id || '' });
        this._treasure = null;
        this._lastStatusAt = 0;
        this.loadTreasure();
    },

    onShareAppMessage: function () {
        var t = this._treasure;
        return share.detailMessage(this.data.id, t && t.name);
    },

    onShow: function () {
        // 每次展示都重新拉一次状态：可能已被别人带走；评论作者资料也重新取一次
        this._authors = null;
        this.loadTreasure();
        this.loadFavoriteState();
        this.refreshDistance();
        this.startTimer();
    },

    onHide: function () {
        this.stopTimer();
    },

    onUnload: function () {
        this.stopTimer();
    },

    loadTreasure: function () {
        var that = this;
        db.get(this.data.id).then(function (t) {
            if (!t || t.status !== 'buried') {
                that.stopTimer();
                wx.showToast({ title: '宝物已不在了', icon: 'none' });
                setTimeout(function () { wx.navigateBack({}); }, 600);
                return;
            }
            that._treasure = t;
            that._lastStatusAt = Date.now();
            // 评论作者资料 30 秒缓存，避免 12 秒轮询反复查库；换昵称/头像后自动生效
            var now = Date.now();
            if (!that._authors || now - (that._authorsAt || 0) > 30000) {
                that._authors = {};
                that._authorsAt = now;
            }
            return db.hintAuthors(t.hints, that._authors).then(function (authors) {
                that.setData({
                    treasure: {
                        name: t.name,
                        riddle: t.riddle,
                        photoPath: t.photoPath,
                        hints: t.hints.map(function (h, idx) {
                            var a = (h.by && authors[h.by]) || null;
                            var author = (a && a.name) || '寻宝人';
                            return {
                                id: 'h' + idx,
                                text: h.text,
                                timeText: geo.relTime(h.at),
                                authorName: author,
                                authorAvatar: (a && a.avatarUrl) || '',
                                authorInitial: author.charAt(0)
                            };
                        }),
                        buriedAtText: geo.relTime(t.createdAt)
                    }
                });
                that.refreshDistance();
                that.loadPhoto();
            });
        });
    },

    /* ---------- 现场照（云存储签名链接，需登录） ---------- */
    loadPhoto: function () {
        var that = this;
        if (!this._treasure || !this._treasure.photoPath) return;
        auth.getSession().then(function (session) {
            if (!session) {
                that.setData({ photoUrl: '', needLogin: true });
                return;
            }
            that.setData({ needLogin: false });
            db.photoUrl(that._treasure.photoPath).then(function (url) {
                that.setData({ photoUrl: url || '' });
            });
        });
    },

    onLoginTap: function () {
        var that = this;
        auth.wechatLogin().then(function (r) {
            if (!r.ok) {
                wx.showToast({ title: r.msg, icon: 'none' });
                return;
            }
            that.setData({ needLogin: false });
            that.loadPhoto();
        });
    },

    previewPhoto: function () {
        if (this.data.photoUrl) {
            wx.previewImage({ urls: [this.data.photoUrl] });
        }
    },

    /* ---------- 收藏（本人私有数据；未登录点击时静默登录） ---------- */
    loadFavoriteState: function () {
        var that = this;
        if (!this.data.id) return;
        db.isFavorite(this.data.id).then(function (fav) {
            that.setData({ favorited: fav });
        });
    },

    toggleFavorite: function () {
        var that = this;
        if (this.data.favBusy) return;
        this.setData({ favBusy: true });
        auth.ensureLogin().then(function (session) {
            if (!session) {
                that.setData({ favBusy: false });
                return wx.showToast({ title: '微信登录后才能收藏', icon: 'none' });
            }
            db.toggleFavorite(that.data.id).then(function (r) {
                that.setData({ favBusy: false });
                if (r.err) {
                    return wx.showToast({ title: r.err, icon: 'none' });
                }
                that.setData({ favorited: r.favorited });
                wx.showToast({
                    title: r.favorited ? '已收藏，可在「我的」查看' : '已取消收藏',
                    icon: 'none'
                });
            });
        });
    },

    /* ---------- 距离与核销判定（用缓存，不请求服务端） ---------- */
    refreshDistance: function () {
        var t = this._treasure;
        if (!t || t.status !== 'buried') {
            return;
        }
        var player = app.globalData.lastLocation;
        if (!player) {
            this.setData({ positionReady: false, inRange: false, distText: '' });
            return;
        }
        var d = geo.dist(player, [t.lng, t.lat]);
        this.setData({
            positionReady: true,
            distText: geo.fmtDist(d),
            inRange: d <= config.CLAIM_RADIUS
        });
    },

    startTimer: function () {
        var that = this;
        this.stopTimer();
        var ticks = 0;
        this._timer = setInterval(function () {
            ticks++;
            // 每 6 轮（12 秒）向云端重拉一次状态，其余轮次只刷新距离
            if (ticks % 6 === 0) {
                that.loadTreasure();
            } else {
                that.refreshDistance();
            }
        }, 2000);
    },

    stopTimer: function () {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    },

    reLocate: function () {
        var that = this;
        wx.getLocation({
            type: 'gcj02',
            isHighAccuracy: true,
            success: function (res) {
                app.globalData.lastLocation = [res.longitude, res.latitude];
                that.refreshDistance();
            },
            fail: function () {
                wx.showToast({
                    title: '定位不可用，请回地图页用「以地图中心定位」放置位置',
                    icon: 'none',
                    duration: 2500
                });
            }
        });
    },

    /* ---------- 操作一：带走（先二次确认，再走服务端原子判定） ---------- */
    takeTreasure: function () {
        var that = this;
        if (!this.data.positionReady) {
            return wx.showToast({ title: '还没拿到你的位置', icon: 'none' });
        }
        if (!this.data.inRange) {
            return wx.showToast({ title: '走近到 30 米内才能带走', icon: 'none' });
        }
        if (this.data.taking) return;

        var name = (this._treasure && this._treasure.name) || '这个宝物';
        // 带走是不可撤销的全局操作（宝物对所有玩家下架），先让用户确认
        wx.showModal({
            title: '确认带走宝物',
            content: '你已经找到并带走「' + name + '」了吗？确认后宝物会从全城地图下架，其他玩家将无法再看到，且不可撤销。',
            confirmText: '确认带走',
            cancelText: '再找找',
            confirmColor: '#e8b04b',
            success: function (res) {
                if (res.confirm) that.doTakeTreasure();
            }
        });
    },

    doTakeTreasure: function () {
        var that = this;
        var name = (this._treasure && this._treasure.name) || '这个宝物';
        this.setData({ taking: true });

        auth.ensureLogin().then(function (session) {
            if (!session) {
                that.setData({ taking: false });
                return wx.showToast({ title: '微信登录后才能带走宝物', icon: 'none' });
            }
            return db.markTaken(that.data.id).then(function (result) {
                that.setData({ taking: false });
                if (result.ok) {
                    that.stopTimer();
                    wx.showModal({
                        title: '带走成功',
                        content: '「' + name + '」已收入你的战利品，可在「我的 → 已带走」里查看。',
                        confirmText: '继续寻宝',
                        cancelText: '查看战利品',
                        confirmColor: '#e8b04b',
                        complete: function (r) {
                            if (r && r.cancel) {
                                wx.reLaunch({ url: '/pages/profile/profile' });
                            } else {
                                wx.reLaunch({ url: '/pages/map/map' });
                            }
                        }
                    });
                } else if (result.reason === 'gone') {
                    wx.showToast({ title: '手慢了，宝物刚被别人带走', icon: 'none' });
                    that.stopTimer();
                    that.loadTreasure();
                } else if (result.reason === 'missing') {
                    wx.showToast({ title: '宝物不存在', icon: 'none' });
                } else {
                    wx.showToast({ title: result.msg || '操作失败，请重试', icon: 'none' });
                }
            });
        });
    },

    /* ---------- 操作二：继续埋藏，追加提示 ---------- */
    onHintInput: function (e) {
        this.setData({ hintInput: e.detail.value });
    },

    submitHint: function () {
        var that = this;
        var hint = (this.data.hintInput || '').trim();
        if (!hint) {
            return wx.showToast({ title: '写一句提示再提交', icon: 'none' });
        }
        if (!this.data.positionReady) {
            return wx.showToast({ title: '还没拿到你的位置', icon: 'none' });
        }
        if (!this.data.inRange) {
            return wx.showToast({ title: '走近到 30 米内才能追加提示', icon: 'none' });
        }
        if (this.data.hintSending) return;
        this.setData({ hintSending: true });

        // 流程：登录 → UGC 内容审核（本地词筛 + 大模型语义审核）→ 服务端原子追加
        auth.ensureLogin().then(function (session) {
            if (!session) {
                throw { stop: true, msg: '微信登录后才能追加提示' };
            }
            wx.showLoading({ title: '内容审核中…', mask: true });
            return sec.checkText(hint).then(function (check) {
                wx.hideLoading();
                if (!check.ok) {
                    throw { stop: true, msg: check.msg };
                }
                return db.addHint(that.data.id, hint).then(function (result) {
                    that.setData({ hintSending: false });
                    if (result.ok) {
                        wx.showToast({ title: '提示已追加，宝物继续埋着', icon: 'none' });
                        that.setData({ hintInput: '' });
                        that.loadTreasure();
                    } else if (result.reason === 'gone') {
                        wx.showToast({ title: '宝物刚被别人带走', icon: 'none' });
                        that.stopTimer();
                        that.loadTreasure();
                    } else if (result.reason === 'missing') {
                        wx.showToast({ title: '宝物不存在', icon: 'none' });
                    } else {
                        throw { stop: true, msg: result.msg || '提交失败，请重试' };
                    }
                });
            });
        }).catch(function (e) {
            wx.hideLoading();
            that.setData({ hintSending: false });
            if (e && e.stop) {
                wx.showToast({ title: e.msg, icon: 'none' });
            } else {
                console.error('[Detail] addHint failed', e && e.message ? e.message : String(e));
                wx.showToast({ title: '提交失败，请重试', icon: 'none' });
            }
        });
    }
});
