// 首页：双入口，不做信息流
Page({
    data: {
        appName: '城市寻宝',
        tagline: '把宝物埋在城市里，让谜题带你走街串巷',
        buriedCount: 0
    },

    goSeek() {
        wx.navigateTo({ url: '/pages/map/map' });
    },

    goBury() {
        wx.navigateTo({ url: '/pages/bury/bury' });
    },

    onShow() {
        var that = this;
        var db = require('../../utils/db');
        db.listBuried().then(function (list) {
            that.setData({ buriedCount: list.length });
        });
    }
});
