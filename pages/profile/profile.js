// 个人中心：用户信息 + 我的收藏 + 我已带走
// 隐私原则：收藏是本人私有数据（云端 RLS 只允许读自己），未登录时不做任何数据请求，
// 只显示登录引导；已带走的列表同样只查 taken_by = 自己。
// 头像/昵称存在 profiles 表（公开读：详情页评论要展示；仅本人可写：RLS 限定 user_id）
var db = require('../../utils/db');
var geo = require('../../utils/geo');
var auth = require('../../utils/auth');
var sec = require('../../utils/sec');

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
        loading: false,
        avatarBusy: false,     // 头像上传中
        nicknameBusy: false    // 昵称审核/保存中
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
            // 优先 profiles 表里的自定义昵称/头像，缺省回退微信登录态
            return db.getMyProfile().then(function (p) {
                var name = (p && p.nickname) || u.name || '寻宝人';
                that.setData({
                    ready: true,
                    loggedIn: true,
                    userName: name,
                    avatarUrl: (p && p.avatarUrl) || u.avatarUrl || '',
                    initial: name.charAt(0),
                    shortId: u.id ? String(u.id).slice(0, 8) : ''
                });
                return that.loadLists();
            });
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

    /* ---------- 头像 / 昵称 ---------- */

    // 微信头像填写能力：点头像 → 选微信头像或相册 → 临时路径上传云存储 → 写 profiles
    onChooseAvatar: function (e) {
        var that = this;
        var tmp = e && e.detail ? e.detail.avatarUrl : '';
        if (!tmp || this.data.avatarBusy) return;
        this.setData({ avatarBusy: true });
        wx.showLoading({ title: '头像上传中…', mask: true });
        auth.ensureLogin().then(function (session) {
            if (!session) throw { msg: '登录后才能设置头像' };
            return db.uploadAvatar(tmp, session);
        }).then(function (up) {
            if (!up || up.err) throw { msg: (up && up.err) || '头像上传失败' };
            return db.saveProfile({ avatarPath: up.path });
        }).then(function (saved) {
            if (!saved || saved.err) throw { msg: (saved && saved.err) || '头像保存失败' };
            wx.hideLoading();
            that.setData({ avatarBusy: false });
            wx.showToast({ title: '头像已更新', icon: 'none' });
            that.refresh();
        }).catch(function (err) {
            wx.hideLoading();
            that.setData({ avatarBusy: false });
            console.error('[Profile] avatar update failed', err && err.msg ? err.msg : String(err));
            wx.showToast({ title: (err && err.msg) || '头像更新失败', icon: 'none' });
        });
    },

    // 昵称：弹窗输入 → 内容审核（与藏宝提示同一套）→ upsert 到 profiles
    onEditNickname: function () {
        var that = this;
        if (this.data.nicknameBusy) return;
        wx.showModal({
            title: '设置昵称',
            editable: true,
            placeholderText: '2-12 个字，会公开展示',
            content: this.data.userName,
            success: function (res) {
                if (!res.confirm) return;
                // 低版本基础库不支持 editable 弹窗时不会回传 content
                if (res.content === undefined) {
                    return wx.showToast({ title: '当前微信版本不支持编辑，请升级后重试', icon: 'none' });
                }
                var name = (res.content || '').trim();
                if (!name) {
                    return wx.showToast({ title: '昵称不能为空', icon: 'none' });
                }
                if (name.length > 12) {
                    return wx.showToast({ title: '昵称最多 12 个字', icon: 'none' });
                }
                that.saveNickname(name);
            }
        });
    },

    saveNickname: function (name) {
        var that = this;
        this.setData({ nicknameBusy: true });
        wx.showLoading({ title: '内容审核中…', mask: true });
        sec.checkText(name).then(function (check) {
            if (!check.ok) {
                wx.hideLoading();
                that.setData({ nicknameBusy: false });
                return wx.showToast({ title: check.msg, icon: 'none' });
            }
            return db.saveProfile({ nickname: name }).then(function (r) {
                wx.hideLoading();
                that.setData({ nicknameBusy: false });
                if (r.err) {
                    return wx.showToast({ title: r.err, icon: 'none' });
                }
                wx.showToast({ title: '昵称已更新', icon: 'none' });
                that.refresh();
            });
        }).catch(function (e) {
            wx.hideLoading();
            that.setData({ nicknameBusy: false });
            console.error('[Profile] nickname save failed', e && e.message ? e.message : String(e));
            wx.showToast({ title: '保存失败，请重试', icon: 'none' });
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
