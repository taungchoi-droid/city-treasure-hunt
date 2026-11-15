// 登录模块：微信一键登录（wx.login + signInWithWechat）
// 仅写操作（藏宝 / 带走 / 追加提示 / 看现场照）需要登录，浏览地图匿名即可
var cloudMod = require('./cloud');
var cloud = cloudMod.cloud;

// 查询当前会话（不弹任何 UI）
function getSession() {
    return cloud.auth.getSession().then(function (r) {
        if (r.error || !r.data) return null;
        return r.data;
    }).catch(function () {
        return null;
    });
}

// 微信一键登录：失败时返回 { ok:false, msg }
function wechatLogin() {
    return new Promise(function (resolve) {
        wx.login({
            success: function (res) {
                if (!res.code) {
                    resolve({ ok: false, msg: '微信登录失败，请重试' });
                    return;
                }
                var appid = '';
                try {
                    appid = wx.getAccountInfoSync().miniProgram.appId;
                } catch (e) { /* 部分环境拿不到时由 SDK 报错 */ }
                cloud.auth.signInWithWechat(res.code, appid).then(function (r) {
                    if (r.error || !r.data) {
                        console.error('[WorkBuddy Cloud] login failed', JSON.stringify({
                            stage: 'signin-with-wechat',
                            message: r.error ? r.error.message : 'empty session'
                        }));
                        resolve({ ok: false, msg: r.error ? r.error.message : '微信登录失败，请重试' });
                        return;
                    }
                    resolve({ ok: true, session: r.data });
                }).catch(function (err) {
                    console.error('[WorkBuddy Cloud] login failed', JSON.stringify({
                        stage: 'signin-with-wechat',
                        message: err && err.message ? err.message : '微信登录失败，请重试'
                    }));
                    resolve({ ok: false, msg: '微信登录失败，请重试' });
                });
            },
            fail: function (err) {
                console.error('[WorkBuddy Cloud] login failed', JSON.stringify({
                    stage: 'wx.login',
                    message: err && err.errMsg ? err.errMsg : 'wx.login failed'
                }));
                resolve({ ok: false, msg: '微信登录失败，请重试' });
            }
        });
    });
}

// 确保已登录（有会话直接复用，没有则静默走一次微信登录）
// 返回 session 或 null
function ensureLogin() {
    return getSession().then(function (session) {
        if (session) return session;
        return wechatLogin().then(function (r) {
            return r.ok ? r.session : null;
        });
    });
}

module.exports = {
    getSession: getSession,
    wechatLogin: wechatLogin,
    ensureLogin: ensureLogin
};
