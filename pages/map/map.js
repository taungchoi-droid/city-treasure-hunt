// 地图页：原生 <map> + markers + circles + show-location
// 注意：markers 使用数字 id（字符串 id 会导致 markertap 拿错）；每次全量 setData
var config = require('../../utils/config');
var db = require('../../utils/db');
var geo = require('../../utils/geo');
var share = require('../../utils/share');

var app = getApp();

Page({
    data: {
        viewState: 'loading', // loading / ready / denied
        latitude: 39.9092,    // 兜底中心（北京），真实位置以定位结果为准
        longitude: 116.3974,
        scale: 16,
        markers: [],
        circles: [],
        nearbyList: [],
        nearbyCount: 0,
        manualMode: false,
        posLabel: '',
        // 查看范围（滚轮）
        radiusLabels: config.RADIUS_OPTIONS.map(function (o) { return o.label; }),
        radiusIndex: 0
    },

    onLoad: function () {
        share.enable(false);
        this._markerIndex = []; // 数字 id -> treasure.id
        this._lastRefreshAt = 0;
        this._fetching = false;
        // 恢复上次的查看范围选择
        var saved = wx.getStorageSync('discover_radius_index');
        if (typeof saved === 'number' && saved >= 0 && saved < config.RADIUS_OPTIONS.length) {
            this.setData({ radiusIndex: saved });
        }
        this.locate();
    },

    onShareAppMessage: function () {
        return share.homeMessage();
    },

    onUnload: function () {
        if (this._locating) {
            try {
                wx.offLocationChange(this._onLocChange);
                wx.stopLocationUpdate();
            } catch (e) { /* 忽略清理失败 */ }
        }
    },

    /* ---------- 定位 ---------- */
    locate: function () {
        var that = this;
        this.setData({ viewState: 'loading' });
        wx.getLocation({
            type: 'gcj02',
            isHighAccuracy: true,
            success: function (res) {
                that.applyPosition([res.longitude, res.latitude], false);
                that.startLiveLocation();
            },
            fail: function () {
                // 降级：改为手动模式（允许选地图中心点当位置），绝不停在 loading
                that.setData({
                    viewState: 'ready',
                    manualMode: true,
                    posLabel: '定位不可用（未授权 / 模拟器）。拖动地图，点「以地图中心定位」手动放置位置'
                });
            }
        });
    },

    startLiveLocation: function () {
        var that = this;
        if (this._locating) return;
        wx.startLocationUpdate({
            success: function () {
                that._locating = true;
                that._onLocChange = function (res) {
                    var now = Date.now();
                    // 节流：最多每 4 秒刷新一次附近列表
                    if (now - that._lastRefreshAt < 4000) return;
                    that._lastRefreshAt = now;
                    that.applyPosition([res.longitude, res.latitude], false, true);
                };
                wx.onLocationChange(that._onLocChange);
            },
            fail: function () { /* 拿不到持续定位时退回手动刷新 */ }
        });
    },

    applyPosition: function (lnglat, manual, keepCenter) {
        app.globalData.lastLocation = lnglat;
        this.setData({
            viewState: 'ready',
            manualMode: manual,
            posLabel: manual ? '模拟位置：' + lnglat[0].toFixed(5) + ', ' + lnglat[1].toFixed(5) : ''
        });
        if (!keepCenter) {
            this.setData({ latitude: lnglat[1], longitude: lnglat[0] });
        }
        this.refreshNearby();
    },

    /* ---------- 手动兜底：以地图中心为位置 ---------- */
    useMapCenter: function () {
        var that = this;
        var ctx = wx.createMapContext('treasureMap', this);
        ctx.getCenterLocation({
            success: function (res) {
                that.applyPosition([res.longitude, res.latitude], true, true);
                wx.showToast({ title: '已用地图中心定位', icon: 'none' });
            },
            fail: function () {
                wx.showToast({ title: '获取地图中心失败', icon: 'none' });
            }
        });
    },

    openSetting: function () {
        wx.openSetting({});
    },

    /* ---------- 查看范围（滚轮） ---------- */
    onRadiusChange: function (e) {
        var idx = Number(e.detail.value);
        if (isNaN(idx) || idx < 0 || idx >= config.RADIUS_OPTIONS.length) return;
        this.setData({ radiusIndex: idx, scale: config.RADIUS_OPTIONS[idx].scale });
        wx.setStorageSync('discover_radius_index', idx);
        this.refreshNearby();
    },

    // 当前生效的查询半径（不限时用极大值）
    _radius: function () {
        var m = config.RADIUS_OPTIONS[this.data.radiusIndex].meters;
        return m === null ? 1e9 : m;
    },

    /* ---------- 附近宝物 ---------- */
    refreshNearby: function () {
        var player = app.globalData.lastLocation;
        if (!player) {
            this.setData({ markers: [], circles: [], nearbyList: [], nearbyCount: 0 });
            return;
        }
        if (this._fetching) { this._pendingRefresh = true; return; }
        this._fetching = true;
        var that = this;
        db.nearby(player, this._radius()).then(function (near) {
            that._fetching = false;
            that.renderNearby(near);
            if (that._pendingRefresh) {
                that._pendingRefresh = false;
                that.refreshNearby();
            }
        });
    },

    renderNearby: function (near) {
        var markers = [];
        var circles = [];
        var list = [];
        var index = [];

        near.forEach(function (item, i) {
            var t = item.treasure;
            // markers 数字 id：0,1,2…
            markers.push({
                id: i,
                latitude: t.lat,
                longitude: t.lng,
                iconPath: '/assets/icons/pin-buried.png',
                width: 32,
                height: 32,
                callout: {
                    content: t.name,
                    display: 'ALWAYS',
                    padding: 6,
                    borderRadius: 8,
                    bgColor: '#1a1408',
                    color: '#e8b04b',
                    fontSize: 12
                }
            });
            // 模糊范围圈：只画圈，核销点靠玩家自己找
            circles.push({
                latitude: t.lat,
                longitude: t.lng,
                radius: config.BLUR_RADIUS,
                color: '#e8962899',
                fillColor: '#e896281F',
                strokeWidth: 2
            });
            list.push({
                id: t.id,
                name: t.name,
                distText: geo.fmtDist(item.distance)
            });
            index.push(t.id);
        });

        this._markerIndex = index;
        // markers / circles 全量 setData，不逐个更新
        this.setData({ markers: markers, circles: circles, nearbyList: list, nearbyCount: list.length });
    },

    onMarkerTap: function (e) {
        var markerId = e.markerId;
        var treasureId = this._markerIndex[markerId];
        if (treasureId) {
            wx.navigateTo({ url: '/pages/detail/detail?id=' + treasureId });
        }
    },

    onRowTap: function (e) {
        var id = e.currentTarget.dataset.id;
        wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
    },

    goBury: function () {
        wx.navigateTo({ url: '/pages/bury/bury' });
    }
});
