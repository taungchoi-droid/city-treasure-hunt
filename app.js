App({
    globalData: {
        appName: '城市寻宝',
        // 最近一次可用的玩家位置 [lng, lat]（GCJ-02），跨页面共享
        lastLocation: null,
        // 隐私授权：当前页面弹窗组件的显示方法 + 平台提供的 resolve 回调
        privacyShow: null,
        privacyResolve: null
    },

    onLaunch: function () {
        var app = this;
        // 云端版：玩家身份由 WorkBuddy 云会话提供（写操作时在页面内触发登录），启动不再生成本地 uid

        // 全局监听隐私授权（基础库 2.32.3+）。
        // wx.onNeedPrivacyAuthorization 是「替换式注册」，只在这里注册一次，
        // 由当前页面的 privacy-modal 组件弹窗并 resolve，避免多页面重复注册互相覆盖。
        // 低版本基础库不接管，交由平台默认链路处理。
        if (!wx.onNeedPrivacyAuthorization) return;
        wx.onNeedPrivacyAuthorization(function (resolve) {
            app.globalData.privacyResolve = resolve;
            // 组件按需注入（lazyCodeLoading），延后一帧再找当前页面弹窗
            setTimeout(function () {
                if (typeof app.globalData.privacyShow === 'function') {
                    app.globalData.privacyShow();
                } else if (app.globalData.privacyResolve) {
                    // 兜底：没有可用弹窗时不能直接丢弃 resolve，否则隐私接口会永久 pending
                    app.globalData.privacyResolve({ event: 'disagree' });
                    app.globalData.privacyResolve = null;
                }
            }, 60);
        });
    }
});
