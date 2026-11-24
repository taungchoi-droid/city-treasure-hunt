// 全局隐私授权弹窗（基础库 2.32.3+）
// 设计要点：wx.onNeedPrivacyAuthorization 是「替换式注册」，因此只在 app.js 注册一次；
// 组件负责把「显示弹窗」的方法挂到 app.globalData.privacyShow（当前页面 hook），
// 用户点击同意/拒绝后再调用平台给的 resolve，让被挂起的隐私接口继续执行或失败。
// 这样避免每个页面重复注册互相覆盖，也避免 navigateBack 后监听失效。
function globalData() {
    return getApp().globalData;
}

Component({
    data: {
        show: false
    },

    lifetimes: {
        attached: function () {
            this._showFn = this.showModal.bind(this);
            globalData().privacyShow = this._showFn;
        },
        detached: function () {
            var g = globalData();
            // 只有当 hook 仍指向自己时才清空，避免误删后来页面的 hook
            if (g.privacyShow === this._showFn) g.privacyShow = null;
        }
    },

    // navigateBack 回到的页面不会重新 attached，需要在 show 时重新抢占 hook
    pageLifetimes: {
        show: function () {
            if (!this._showFn) this._showFn = this.showModal.bind(this);
            globalData().privacyShow = this._showFn;
        }
    },

    methods: {
        showModal: function () {
            this.setData({ show: true });
        },

        noop: function () {},

        openContract: function () {
            // 需在小程序后台配置并审核通过《用户隐私保护指引》后才可打开
            if (!wx.openPrivacyContract) {
                wx.showToast({ title: '请在小程序后台完善隐私指引', icon: 'none' });
                return;
            }
            wx.openPrivacyContract({
                fail: function () {
                    wx.showToast({ title: '隐私指引暂不可用', icon: 'none' });
                }
            });
        },

        // 由 <button open-type="agreePrivacyAuthorization"> 触发；
        // 基础库会校验该按钮确实被点击过，才允许 resolve({ event: 'agree' })
        onAgree: function () {
            var g = globalData();
            var resolve = g.privacyResolve;
            this.setData({ show: false });
            g.privacyResolve = null;
            if (resolve) resolve({ buttonId: 'agree-btn', event: 'agree' });
        },

        onDisagree: function () {
            var g = globalData();
            var resolve = g.privacyResolve;
            this.setData({ show: false });
            g.privacyResolve = null;
            wx.showToast({
                title: '未同意隐私指引，部分功能不可用',
                icon: 'none',
                duration: 2500
            });
            if (resolve) resolve({ event: 'disagree' });
        }
    }
});
