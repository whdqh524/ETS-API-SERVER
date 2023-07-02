"use strict";

let { Router } = require('express');
let router = Router();
const env = process.env.NODE_ENV || "development";
const model = (env === 'product') ? require('@aitraum/ets-spot-common.git/model') : require('../../common/model');

router.get('/layer', async (req, res, next) => {
    try {
        const layerNotices = await model['LayerNotice'].getActivatedLayer(req.query.language);
        await next({status: 'success', data: layerNotices});
    }
    catch (e) {
        next(e);
    }
});

router.get('/rolling', async (req, res, next) => {
    try {
        const rollingNotices = await model['RollingNotice'].getActivatedRolling(req.query.language);
        await next({status: 'success', data: rollingNotices});
    }
    catch (e) {
        next(e);
    }
});

module.exports = router;