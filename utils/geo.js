// 距离与方位：全部自写 haversine，不依赖地图组件测距（不同基础库行为不一致）
function rad(d) {
  return (d * Math.PI) / 180;
}

// 两点球面距离，参数 [lng, lat] 均为 GCJ-02
function dist(a, b) {
  var R = 6371000;
  var dLat = rad(b[1] - a[1]);
  var dLng = rad(b[0] - a[0]);
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fmtDist(m) {
  if (m >= 1000) {
    return (m / 1000).toFixed(2) + ' km';
  }
  return Math.round(m) + ' m';
}

function relTime(ts) {
  var diff = Date.now() - ts;
  var min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  var hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' 小时前';
  return Math.floor(hour / 24) + ' 天前';
}

module.exports = { dist: dist, fmtDist: fmtDist, relTime: relTime };
