// 全局配置：距离阈值（米）
// 云端版说明：核销判定仍在客户端，但「带走/加提示」由服务端原子 RPC 落库裁决
module.exports = {
  DISCOVER_RADIUS: 300, // 默认发现半径：进入该范围才出现在地图/列表
  BLUR_RADIUS: 80,      // 模糊半径：只画范围圈，不给精确点
  CLAIM_RADIUS: 30,     // 核销半径：走进该范围才解锁「带走 / 追加提示」

  // 用户可自选的查看范围（滚轮选项）
  // meters 为 null 表示不限范围（项目初期宝物少，方便全局看到所有点）
  RADIUS_OPTIONS: [
    { label: '300 米', meters: 300, scale: 16 },
    { label: '500 米', meters: 500, scale: 15 },
    { label: '1 公里', meters: 1000, scale: 14 },
    { label: '2 公里', meters: 2000, scale: 13 },
    { label: '5 公里', meters: 5000, scale: 12 },
    { label: '10 公里', meters: 10000, scale: 11 },
    { label: '20 公里', meters: 20000, scale: 10 },
    { label: '不限', meters: null, scale: 9 }
  ],

  // ---- 沿道路路线（腾讯位置服务 WebService API）----
  // ① 申请 Key：https://lbs.qq.com/dev/console/key → 创建 Key
  //    勾选「WebServiceAPI」，并在「微信小程序」中填 AppID: wx6946e64723f37889
  //    新 Key 默认额度为 0，需到「配额管理」为它分配调用额度，否则会返回配额不足
  // ② 微信公众平台：开发管理 → 开发设置 → 服务器域名 → request 合法域名
  //    添加 https://apis.map.qq.com（开发者工具可临时勾选「不校验合法域名」调试）
  // ③ 把 Key 填到下面这一行。留空时导航自动降级为直线方位，不影响其它功能。
  TENCENT_MAP_KEY: 'MVYBZ-IK4CQ-Z4V5A-4SQ7J-FOZN3-AMFYP',
  ROUTE_MODE: 'walking',        // walking / bicycling / driving（城市寻宝默认步行）
  ROUTE_TIMEOUT_MS: 8000,       // 单次算路超时（毫秒）
  ROUTE_REPLAN_DIST: 100,       // 当前位置移动超过该距离才重新算路（米），省调用额度
  ROUTE_REPLAN_MIN_MS: 30000    // 两次算路的最小间隔（毫秒）
};
