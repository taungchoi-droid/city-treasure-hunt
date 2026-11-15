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
  ]
};
