// 全局配置：距离阈值（米），v1 不做服务端校验
module.exports = {
  DISCOVER_RADIUS: 300, // 发现半径：进入该范围才出现在地图/列表，防止远程扫点
  BLUR_RADIUS: 80,      // 模糊半径：只画范围圈，不给精确点
  CLAIM_RADIUS: 30,     // 核销半径：走进该范围才解锁「带走 / 追加提示」
  STORAGE_KEY: 'cth_treasures_v1',
  UID_KEY: 'cth_uid_v1'
};
