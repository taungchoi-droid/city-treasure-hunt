App({
  globalData: {
    appName: '城市寻宝',
    // 最近一次可用的玩家位置 [lng, lat]（GCJ-02），跨页面共享
    lastLocation: null
  },
  onLaunch: function () {
    // 云端版：玩家身份由 WorkBuddy 云会话提供（写操作时在页面内触发登录），启动不再生成本地 uid
  }
});
