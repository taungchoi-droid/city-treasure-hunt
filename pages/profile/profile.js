// 个人中心：用户信息 + 我的收藏 + 我已带走
// 隐私原则：收藏是本人私有数据（云端 RLS 只允许读自己），未登录时不做任何数据请求，
// 只显示登录引导；已带走的列表同样只查 taken_by = 自己。
var db = require('../../utils/db');
var geo = require('../../utils/geo');
var auth = require('../../utils/auth');

var app = getApp();

Page({
    data: {
        ready: false,          // 是否完成首次会话检查（避免空白闪烁）
        loggedIn: false,
        userName: '',
        avatarUrl: '',
        initial: '',
        shortId: '',
        stats: { favorites: 0, taken: 0, buried: 0 },
        tab: 'fav',            // fav = 收藏，taken = 已带走
        favorites: [],
        taken: [],
        loading: false
    },

    onShow: function () {
        this.refresh();
    },

    onPullDownRefresh: function () {
        var that = this;
        this.refresh().then(function () {
            wx.stopPullDownRefresh();
        });
    },

    /* ---------- 会话 + 数据加载 ---------- */
    refresh: function () {
        var that = this;
        return auth.getSession().then(function (session) {
            if (!session || !session.user) {
                that.setData({
                    ready: true,
                    loggedIn: false,
                    userName: '',
                    avatarUrl: '',
                    initial: '',
                    shortId: '',
                    favorites: [],
                    taken: [],
                    stats: { favorites: 0, taken: 0, buried: 0 }
                });
                return;
            }
            var u = session.user;
            var name = u.name || '寻宝人';
            that.setData({
                ready: true,
                loggedIn: true,
                userName: name,
                avatarUrl: u.avatarUrl || '',
                initial: name.charAt(0),
                shortId: u.id ? String(u.id).slice(0, 8) : ''
            });
            return that.loadLists();
        }).catch(function (e) {
            console.error('[Profile] refresh failed', e && e.message ? e.message : String(e));
            that.setData({ ready: true });
        });
    },

    loadLists: function () {
        var that = this;
        this.setData({ loading: true });
        return Promise.all([db.listFavorites(), db.listTaken(), db.countMyBuried()])
            .then(function (res) {
                var favRes = res[0] || { list: [] };
                var takenRes = res[1] || { list: [] };
                var buriedCount = res[2] || 0;

                // 收藏：保留已被带走的记录并标记状态（用户可自行取消收藏）
                var favorites = (favRes.list || []).map(function (f) {
                    var distText = '';
                    var player = app.globalData.lastLocation;
                    if (player && f.status === 'buried') {
                        distText = geo.fmtDist(geo.dist(player, [f.lng, f.lat]));
                    }
                    return {
                        id: f.id,
                        name: f.name,
                        status: f.status,
                        statusText: f.status === 'buried' ? '可寻' : '已被带走',
                        gone: f.status !== 'buried',
                        subText: distText ? '距你 ' + distText : ''
                    };
                });

                var taken = (takenRes.list || []).map(function (t) {
                    var distText = '';
                    var player = app.globalData.lastLocation;
                    if (player) {
                        distText = geo.fmtDist(geo.dist(player, [t.lng, t.lat]));
                    }
                    return {
                        id: t.id,
                        name: t.name,
                        subText: geo.relTime(t.updatedAt) + '带走' + (distText ? ' · 距你 ' + distText : '')
                    };
                });

                that.setData({
                    loading: false,
                    favorites: favorites,
                    taken: taken,
                    stats: {
                        favorites: favorites.length,
                        taken: taken.length,
                        buried: buriedCount
                    }
                });
            })
            .catch(function (e) {
                console.error('[Profile] loadLists failed', e && e.message ? e.message : String(e));
                that.setData({ loading: false });
                wx.showToast({ title: '加载失败，下拉重试', icon: 'none' });
            });
    },

    /* ---------- 登录 ---------- */
    onLoginTap: function () {
        var that = this;
        wx.showLoading({ title: '登录中…', mask: true });
        auth.wechatLogin().then(function (r) {
            wx.hideLoading();
            if (!r.ok) {
                wx.showToast({ title: r.msg, icon: 'none' });
                return;
            }
            that.refresh();
        });
    },

    /* ---------- 交互 ---------- */
    switchTab: function (e) {
        var tab = e.currentTarget.dataset.tab;
        if (tab === this.data.tab) return;
        this.setData({ tab: tab });
    },

    onFavTap: function (e) {
        var id = e.currentTarget.dataset.id;
        var status = e.currentTarget.dataset.status;
        if (status !== 'buried') {
            return wx.showToast({ title: '这个宝物已被带走', icon: 'none' });
        }
        wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
    },

    onUnfavorite: function (e) {
        var that = this;
        var id = e.currentTarget.dataset.id;
        db.toggleFavorite(id).then(function (r) {
            if (r.err) {
                return wx.showToast({ title: r.err, icon: 'none' });
            }
            wx.showToast({ title: r.favorited ? '已收藏' : '已取消收藏', icon: 'none' });
            that.loadLists();
        });
    },

    goSeek: function () {
        wx.navigateTo({ url: '/pages/map/map' });
    }
});
