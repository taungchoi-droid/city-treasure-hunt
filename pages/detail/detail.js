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
        taking: false
    },

    onLoad: function (options) {
        this.setData({ id: options.id || '' });
        this._treasure = null;
        this._lastStatusAt = 0;
        this.loadTreasure();
    },

    onShow: function () {
        // 每次展示都重新拉一次状态：可能已被别人带走
        this.loadTreasure();
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
            that.setData({
                treasure: {
                    name: t.name,
                    riddle: t.riddle,
                    photoPath: t.photoPath,
                    hints: t.hints.map(function (h, idx) {
                        return { id: 'h' + idx, text: h.text, timeText: geo.relTime(h.at) };
                    }),
                    buriedAtText: geo.relTime(t.createdAt)
                }
            });
            that.refreshDistance();
            that.loadPhoto();
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

    /* ---------- 操作一：带走（服务端原子判定） ---------- */
    takeTreasure: function () {
        var that = this;
        if (!this.data.positionReady) {
            return wx.showToast({ title: '还没拿到你的位置', icon: 'none' });
        }
        if (!this.data.inRange) {
            return wx.showToast({ title: '走近到 30 米内才能带走', icon: 'none' });
        }
        if (this.data.taking) return;
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
                    wx.showToast({ title: '宝物归你了！', icon: 'success' });
                    setTimeout(function () {
                        wx.reLaunch({ url: '/pages/map/map' });
                    }, 800);
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
            return sec.checkText(hint).then(function (check) {
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
