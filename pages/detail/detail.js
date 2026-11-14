// 宝物详情：谜题 + 提示列表 + 两个按距离解锁的操作按钮
// 硬规则：「我已带走」必须数据层写成功后才改 UI；onShow 时重新拉状态，处理"已被别人带走"
var config = require('../../utils/config');
var db = require('../../utils/db');
var geo = require('../../utils/geo');
var sec = require('../../utils/sec');

var app = getApp();

Page({
    data: {
        id: '',
        treasure: null,
        distText: '',
        inRange: false,      // 是否进入核销半径
        positionReady: false,
        hintInput: '',
        hintSending: false,
        taking: false
    },

    onLoad: function (options) {
        this.setData({ id: options.id || '' });
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
        var t = db.get(this.data.id);
        if (!t || t.status !== 'buried') {
            wx.showToast({ title: '宝物已不在了', icon: 'none' });
            setTimeout(function () { wx.navigateBack({}); }, 600);
            return;
        }
        this.setData({
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
    },

    /* ---------- 距离与核销判定 ---------- */
    refreshDistance: function () {
        var t = db.get(this.data.id);
        if (!t || t.status !== 'buried') {
            this.stopTimer();
            wx.showToast({ title: '宝物已被人带走', icon: 'none' });
            var that = this;
            setTimeout(function () { that.loadTreasure(); }, 500);
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
        this._timer = setInterval(function () {
            var t = db.get(that.data.id);
            if (!t || t.status !== 'buried') {
                that.loadTreasure();
                return;
            }
            that.refreshDistance();
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

    /* ---------- 操作一：带走 ---------- */
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

        // 先落库，成功后才改 UI
        var result = db.markTaken(this.data.id);
        this.setData({ taking: false });
        if (result.ok) {
            wx.showToast({ title: '宝物归你了！', icon: 'success' });
            setTimeout(function () {
                wx.reLaunch({ url: '/pages/map/map' });
            }, 800);
        } else if (result.reason === 'gone') {
            wx.showToast({ title: '手慢了，宝物刚被别人带走', icon: 'none' });
            this.stopTimer();
            setTimeout(function () { that.loadTreasure(); }, 500);
        } else {
            wx.showToast({ title: '宝物不存在', icon: 'none' });
        }
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
        var check = sec.checkText(hint);
        if (!check.ok) {
            return wx.showToast({ title: check.msg, icon: 'none' });
        }
        if (this.data.hintSending) return;
        this.setData({ hintSending: true });

        var result = db.addHint(this.data.id, hint);
        this.setData({ hintSending: false });
        if (result.ok) {
            wx.showToast({ title: '提示已追加，宝物继续埋着', icon: 'none' });
            this.setData({ hintInput: '' });
            this.loadTreasure();
        } else if (result.reason === 'gone') {
            wx.showToast({ title: '宝物刚被别人带走', icon: 'none' });
            this.stopTimer();
            setTimeout(function () { that.loadTreasure(); }, 500);
        } else {
            wx.showToast({ title: '宝物不存在', icon: 'none' });
        }
    }
});
