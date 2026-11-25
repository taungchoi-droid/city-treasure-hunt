// 小程序分享：统一配置
// 微信机制：页面只有定义了 onShareAppMessage，右上角胶囊菜单里的「转发给朋友」才
// 可点击；未定义时该入口是灰色的。「分享到朋友圈」还需页面定义 onShareTimeline，
// 并通过 wx.showShareMenu({ menus: [...] }) 显式开启。
var HOME_PATH = '/pages/index/index';
var DEFAULT_TITLE = '城市寻宝｜把宝物埋在城市里，让谜题带你走街串巷';

// 页面 onLoad / onShow 调一次，点亮当前页面的分享入口。
// withTimeline 仅首页传 true：朋友圈打开是「单页模式」，定位、登录等能力受限，
// 首页以信息展示为主最安全；其余页面只开转发。
function enable(withTimeline) {
    if (!wx.showShareMenu) return;
    var opts = {
        withShareTicket: true,
        menus: withTimeline
            ? ['shareAppMessage', 'shareTimeline']
            : ['shareAppMessage']
    };
    try {
        wx.showShareMenu(opts);
    } catch (e) {
        // 低版本基础库不识别 menus 参数，退回默认（仅转发）
        try { wx.showShareMenu({ withShareTicket: true }); } catch (e2) {}
    }
}

// 通用：转发给朋友，落点是首页
function homeMessage() {
    return {
        title: DEFAULT_TITLE,
        path: HOME_PATH
    };
}

// 详情页：path 带上宝物 id，朋友点开直接落到这个宝物的详情
function detailMessage(id, name) {
    var short = String(name || '').slice(0, 10);
    return {
        title: short
            ? '「' + short + '」被埋在城市里了，来解开谜题找找看'
            : '有人在城市里埋了个宝物，来解开谜题找找看',
        path: '/pages/detail/detail?id=' + encodeURIComponent(id || '')
    };
}

// 朋友圈（仅首页）：不能指定 path，只能带 query
function homeTimeline() {
    return {
        title: DEFAULT_TITLE,
        query: ''
    };
}

module.exports = {
    enable: enable,
    homeMessage: homeMessage,
    detailMessage: detailMessage,
    homeTimeline: homeTimeline
};
