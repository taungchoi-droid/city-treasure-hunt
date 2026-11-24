// 首页：双入口，不做信息流
Page({
    data: {
        appName: '城市寻宝',
        tagline: '把宝物埋在城市里，让谜题带你走街串巷',
        buriedCount: 0
    },

    onLoad() {
        // 进入小程序先完成隐私授权：已同意会直接 success，未同意则触发
        // app.js 里注册的 onNeedPrivacyAuthorization，由全局弹窗接管
        if (wx.requirePrivacyAuthorize) {
            wx.requirePrivacyAuthorize({
                success: function () {},
                fail: function () {}
            });
        }
    },

    goSeek() {
        wx.navigateTo({ url: '/pages/map/map' });
    },

    goBury() {
        wx.navigateTo({ url: '/pages/bury/bury' });
    },

    goProfile() {
        wx.navigateTo({ url: '/pages/profile/profile' });
    },

    onShow() {
        var that = this;
        var db = require('../../utils/db');
        db.listBuried().then(function (list) {
            that.setData({ buriedCount: list.length });
        });
    }
});
