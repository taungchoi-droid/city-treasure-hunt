var db = require('./utils/db');

App({
  globalData: {
    appName: '城市寻宝',
    // 最近一次可用的玩家位置 [lng, lat]（GCJ-02），跨页面共享
    lastLocation: null
  },
  onLaunch: function () {
    db.getUid();
  }
});
