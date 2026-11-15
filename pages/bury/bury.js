// 藏宝页：取当前位置 → 命名 + 谜题 → 拍现场照 → 提交（status=buried 落库）
// 坐标只用 wx.getLocation({ type: 'gcj02' }) 的返回值，不做二次转换
// 现场照为防刷硬性要求：不上传照片不允许提交，照片上传云端 shared 存储
var db = require('../../utils/db');
var sec = require('../../utils/sec');
var auth = require('../../utils/auth');

var app = getApp();

Page({
    data: {
        positionReady: false,
        posText: '',
        manualMode: false,
        showPickMap: false,
        pickLatitude: 39.9092,
        pickLongitude: 116.3974,
        name: '',
        riddle: '',
        photoPath: '',
        submitting: false
    },

    onShow: function () {
        if (!this.data.positionReady) {
            this.locate();
        }
    },

    /* ---------- 定位（自动 + 手动兜底） ---------- */
    locate: function () {
        var that = this;
        wx.getLocation({
            type: 'gcj02',
            isHighAccuracy: true,
            success: function (res) {
                app.globalData.lastLocation = [res.longitude, res.latitude];
                that.setData({
                    positionReady: true,
                    manualMode: false,
                    showPickMap: false,
                    posText: '已定位：' + res.longitude.toFixed(5) + ', ' + res.latitude.toFixed(5)
                });
            },
            fail: function () {
                // 兜底：打开手动选点地图，拿不到位置绝不能卡死
                that.setData({
                    positionReady: false,
                    manualMode: true,
                    showPickMap: true,
                    posText: '定位不可用，请拖动地图把中心对准埋宝位置'
                });
                if (app.globalData.lastLocation) {
                    that.setData({
                        pickLatitude: app.globalData.lastLocation[1],
                        pickLongitude: app.globalData.lastLocation[0]
                    });
                }
            }
        });
    },

    useMapCenter: function () {
        var that = this;
        var ctx = wx.createMapContext('pickMap', this);
        ctx.getCenterLocation({
            success: function (res) {
                app.globalData.lastLocation = [res.longitude, res.latitude];
                that.setData({
                    positionReady: true,
                    showPickMap: false,
                    posText: '已选点：' + res.longitude.toFixed(5) + ', ' + res.latitude.toFixed(5)
                });
            },
            fail: function () {
                wx.showToast({ title: '获取地图中心失败', icon: 'none' });
            }
        });
    },

    reLocate: function () {
        this.setData({ showPickMap: false });
        this.locate();
    },

    openPickMap: function () {
        this.setData({ showPickMap: true });
    },

    /* ---------- 表单 ---------- */
    onNameInput: function (e) {
        this.setData({ name: e.detail.value });
    },

    onRiddleInput: function (e) {
        this.setData({ riddle: e.detail.value });
    },

    /* ---------- 拍照确认（相机，压缩，防止直传超时） ---------- */
    takePhoto: function () {
        var that = this;
        wx.chooseMedia({
            count: 1,
            mediaType: ['image'],
            sourceType: ['camera'],
            sizeType: ['compressed'],
            camera: 'back',
            success: function (res) {
                if (!res.tempFiles || !res.tempFiles.length) return;
                var tempPath = res.tempFiles[0].tempFilePath;
                // 持久化到本地用户目录，避免 tempFile 失效
                var fs = wx.getFileSystemManager();
                fs.saveFile({
                    tempFilePath: tempPath,
                    success: function (sres) {
                        that.setData({ photoPath: sres.savedFilePath });
                    },
                    fail: function () {
                        // 保存失败时退回临时路径（本次会话内可用）
                        that.setData({ photoPath: tempPath });
                    }
                });
            },
            fail: function (res) {
                if (res.errMsg && res.errMsg.indexOf('auth') !== -1) {
                    wx.showToast({ title: '未授权相机，可在设置中开启', icon: 'none' });
                }
            }
        });
    },

    previewPhoto: function () {
        if (this.data.photoPath) {
            wx.previewImage({ urls: [this.data.photoPath] });
        }
    },

    /* ---------- 提交（云端版：登录 → 照片上云 → 落库） ---------- */
    submit: function () {
        var that = this;
        var name = (this.data.name || '').trim();
        var riddle = (this.data.riddle || '').trim();
        var photoPath = this.data.photoPath;

        if (!this.data.positionReady) {
            return wx.showToast({ title: '先定位或选点', icon: 'none' });
        }
        if (!name) {
            return wx.showToast({ title: '给宝物起个名字', icon: 'none' });
        }
        if (name.length > 20) {
            return wx.showToast({ title: '名字控制在 20 字以内', icon: 'none' });
        }
        if (riddle.length < 5) {
            return wx.showToast({ title: '谜题至少写 5 个字', icon: 'none' });
        }
        if (!photoPath) {
            return wx.showToast({ title: '拍一张现场照确认藏宝', icon: 'none' });
        }

        // UGC 内容检查（本地占位，正式版需接 msgSecCheck）
        var nameCheck = sec.checkText(name);
        if (!nameCheck.ok) {
            return wx.showToast({ title: nameCheck.msg, icon: 'none' });
        }
        var riddleCheck = sec.checkText(riddle);
        if (!riddleCheck.ok) {
            return wx.showToast({ title: riddleCheck.msg, icon: 'none' });
        }

        if (this.data.submitting) return;
        this.setData({ submitting: true });

        var pos = app.globalData.lastLocation;
        auth.ensureLogin().then(function (session) {
            if (!session) {
                that.setData({ submitting: false });
                return wx.showToast({ title: '微信登录后才能藏宝', icon: 'none' });
            }
            // 现场照上传到云存储（shared，其他玩家可看）
            return db.uploadPhoto(photoPath, session).then(function (up) {
                if (up.err) {
                    that.setData({ submitting: false });
                    return wx.showToast({ title: up.err, icon: 'none' });
                }
                return db.insert({
                    name: name,
                    riddle: riddle,
                    lng: pos[0],
                    lat: pos[1],
                    photoPath: up.path
                }).then(function (record) {
                    that.setData({ submitting: false });
                    if (record && record.id) {
                        wx.showToast({ title: '埋好了！等别人来挖', icon: 'success' });
                        setTimeout(function () {
                            wx.reLaunch({ url: '/pages/map/map' });
                        }, 900);
                    } else {
                        wx.showToast({ title: (record && record.err) || '提交失败，请重试', icon: 'none' });
                    }
                });
            });
        });
    }
});
