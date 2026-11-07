'use strict';

/**
 * 内置「空场景」模板 —— 用于项目里一个 .fire 都没有时的冷启动。
 *
 * 字段集合照抄 Cocos Creator 2.4.x 引擎自带的 canvas 内置预制体
 * （cc.Camera / cc.Canvas / cc.Widget 的完整序列化字段），避免手写
 * .fire 时缺字段导致编辑器反序列化补默认值。
 *
 * 目标：scene_create 在空项目里一次产出「可预览的标准场景」
 * （SceneAsset + Scene + Canvas + Main Camera），不再要求调用方
 * 先在编辑器里手工建一个空场景。
 */

var crypto = require('crypto');

function newId() {
    var h = crypto.randomBytes(16).toString('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
        h.slice(16, 20) + '-' + h.slice(20);
}

function trs(x, y, z) {
    return {
        __type__: 'TypedArray',
        ctor: 'Float64Array',
        array: [x, y, z, 0, 0, 0, 1, 1, 1, 1]
    };
}

function vec3() { return { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }; }
function white() {
    return { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 };
}
function size(w, h) { return { __type__: 'cc.Size', width: w, height: h }; }
function anchor() { return { __type__: 'cc.Vec2', x: 0.5, y: 0.5 }; }

function nodeObj(name, parentId, w, h, x, y, z, compIds, childIds) {
    return {
        __type__: 'cc.Node',
        _name: name,
        _objFlags: 0,
        _parent: parentId === null ? null : { __id__: parentId },
        _children: childIds.map(function (i) { return { __id__: i }; }),
        _active: true,
        _components: compIds.map(function (i) { return { __id__: i }; }),
        _prefab: null,
        _opacity: 255,
        _color: white(),
        _contentSize: size(w, h),
        _anchorPoint: anchor(),
        _trs: trs(x, y, z),
        _eulerAngles: vec3(),
        _skewX: 0,
        _skewY: 0,
        _is3DNode: false,
        _groupIndex: 0,
        groupIndex: 0,
        _id: newId()
    };
}

function sceneObj(name) {
    var n = nodeObj(name, null, 0, 0, 0, 0, 0, [], []);
    n.__type__ = 'cc.Scene';
    n._tag = -1;
    n.autoReleaseAssets = false;
    return n;
}

function cameraComp(nodeId) {
    return {
        __type__: 'cc.Camera',
        _name: '', _objFlags: 0,
        node: { __id__: nodeId },
        _enabled: true,
        _cullingMask: 4294967295,
        _clearFlags: 7,
        _backgroundColor: { __type__: 'cc.Color', r: 0, g: 0, b: 0, a: 255 },
        _depth: -1,
        _zoomRatio: 1,
        _targetTexture: null,
        _fov: 60,
        _orthoSize: 10,
        _nearClip: 1,
        _farClip: 4096,
        _ortho: true,
        _rect: { __type__: 'cc.Rect', x: 0, y: 0, width: 1, height: 1 },
        _renderStages: 1,
        _alignWithScreen: true,
        _id: ''
    };
}

function canvasComp(nodeId, w, h) {
    return {
        __type__: 'cc.Canvas',
        _name: '', _objFlags: 0,
        node: { __id__: nodeId },
        _enabled: true,
        _designResolution: size(w, h),
        _fitWidth: false,
        _fitHeight: true,
        _id: ''
    };
}

function widgetComp(nodeId) {
    return {
        __type__: 'cc.Widget',
        _name: '', _objFlags: 0,
        node: { __id__: nodeId },
        _enabled: true,
        alignMode: 1,
        _target: null,
        _alignFlags: 45,
        _left: 0, _right: 0, _top: 0, _bottom: 0,
        _verticalCenter: 0, _horizontalCenter: 0,
        _isAbsLeft: true, _isAbsRight: true, _isAbsTop: true,
        _isAbsBottom: true, _isAbsHorizontalCenter: true,
        _isAbsVerticalCenter: true,
        _originalWidth: 0, _originalHeight: 0,
        _id: ''
    };
}

/**
 * 生成 Canvas + Main Camera + 三个组件，共 5 个对象。
 * base 是这 5 个对象在目标数组里的起始下标；内部所有 __id__ 直接按 base 生成，
 * 不做二次偏移（避免把指向 cc.Scene 的 _parent 也一起改掉）。
 */
function makeCanvasObjects(sceneId, w, h, base) {
    var canvasId = base;
    var cameraId = base + 1;
    var cameraCompId = base + 2;
    var canvasCompId = base + 3;
    var widgetCompId = base + 4;

    return {
        canvasId: canvasId,
        objects: [
            nodeObj('Canvas', sceneId, w, h, w / 2, h / 2, 0,
                [canvasCompId, widgetCompId], [cameraId]),
            nodeObj('Main Camera', canvasId, 0, 0, 0, 0, 365.46272039703314,
                [cameraCompId], []),
            cameraComp(cameraId),
            canvasComp(canvasId, w, h),
            widgetComp(canvasId)
        ]
    };
}

function hasCanvas(arr) {
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].__type__ === 'cc.Node' && arr[i]._name === 'Canvas') return true;
    }
    return false;
}

/** 完整空场景（7 个对象）：SceneAsset + Scene + Canvas 一套 */
function buildEmptyScene(opts) {
    opts = opts || {};
    var w = (opts.design && opts.design[0]) || 960;
    var h = (opts.design && opts.design[1]) || 640;
    var sceneName = opts.name || 'Main';

    var asset = {
        __type__: 'cc.SceneAsset',
        _name: '', _objFlags: 0, _native: '',
        scene: { __id__: 1 }
    };
    var scene = sceneObj(sceneName);
    var parts = makeCanvasObjects(1, w, h, 2);
    scene._children = [{ __id__: parts.canvasId }];

    return [asset, scene].concat(parts.objects);
}

/**
 * 给已有（可能为空的）场景数组补 Canvas / Main Camera。
 * 返回追加的对象数；已有 Canvas 则原样返回 0。
 */
function attachCanvas(arr, opts) {
    if (hasCanvas(arr)) return 0;
    opts = opts || {};
    var w = (opts.design && opts.design[0]) || 960;
    var h = (opts.design && opts.design[1]) || 640;

    var sceneId = -1;
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].__type__ === 'cc.Scene') { sceneId = i; break; }
    }
    if (sceneId < 0) return 0;

    var parts = makeCanvasObjects(sceneId, w, h, arr.length);
    for (var j = 0; j < parts.objects.length; j++) arr.push(parts.objects[j]);

    arr[sceneId]._children = arr[sceneId]._children || [];
    arr[sceneId]._children.push({ __id__: parts.canvasId });
    return parts.objects.length;
}

module.exports = {
    buildEmptyScene: buildEmptyScene,
    attachCanvas: attachCanvas,
    hasCanvas: hasCanvas
};
