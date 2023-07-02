"use strict";

let { Router } = require('express');
let router = Router();
const env = process.env.NODE_ENV || "development";
const etsSpotCommon = (env === 'product') ? require('@aitraum/ets-spot-common.git') : require('../../common');
const exchangeModuels = (env === 'product') ? require('@aitraum/ets-spot-exchange-modules.git') : require('../../exchange');
const model = (env === 'product') ? require('@aitraum/ets-spot-common.git/model') : require('../../common/model');
const { ParameterError, OrderPlanNotExistError, NotInputExchangeApiKeyError, NotAllowedVirtualBasicOrderError, NotAllowedPlanTypeForApiError, ClearingBatchSellFailed } = etsSpotCommon.error;
const { config, redisCtrl } = etsSpotCommon;
const { authHandler, exchangeHandler, validateParameter } = require('../handler/packetHandler');

const requiredKeyMap = {
    pubilc: ['symbol', 'base', 'quote', 'direction'],
    runOrder: ['openInfo', 'takeProfitInfo', 'stopLossInfo'],
    runStrategy: ['strategyId', 'qty', 'symbol', 'base', 'quote'],
    completeStrategy: ['orderPlanId'],
    saveStrategy: ['openIndicators', 'takeIndicators', 'lossIndicators', 'name', 'backtestingResult'],
    orderinfo: ['orderPlanId','openInfo', 'takeProfitInfo', 'stopLossInfo'],
    completeOrderHistory: ['planType', 'isVirtual'],
    receipts: ['isVirtual', 'startDate', 'endDate']
};

router.use(authHandler);
router.use(exchangeHandler);

router.post('/new/:planType', async (req, res, next) => {
    const seqTransaction = await model.sequelize.transaction();
    try {
        const exchange = req.headers.exchange;
        const planType = req.params.planType;
        if(!planType) {
            throw new ParameterError(`PlanType`);
        }
        const checkArray = (planType === 'strategy') ? requiredKeyMap['runStrategy'] : requiredKeyMap.pubilc.concat(requiredKeyMap['runOrder']);
        validateParameter(checkArray, req.body);
        const user = req.user;
        if((!user.apiKeyMap[exchange] || user.apiKeyMap[exchange].apiKey.length == 0 || user.apiKeyMap[exchange].alive == false) && !req.body.isVirtual) {
            throw new NotInputExchangeApiKeyError();
        }
        if(req.body.isVirtual === true && planType === 'basic') throw new NotAllowedVirtualBasicOrderError();
        await model['OrderPlan'].checkUserOrdersCount(req.user, exchange, req.body.isVirtual);
        await model['OrderPlan'].checkExistOpposeDirectionOrderPlan(req.user.id, planType, exchange, req.body.symbol,
            req.body.direction, (req.body.isVirtual == true) ? true : false);

        let [openPrice, openQty]  = [0, 0];
        if(planType == 'strategy') {
            openQty = req.body.qty;
        }
        else {
            openQty = req.body.openInfo[0].qty;
            openPrice = req.body.openInfo[0].enterPrice || 0;
        }
        await exchangeModuels[exchange].Api.checkBalance(req.user.id, req.body.direction, req.body.isVirtual, exchange, req.body.symbol, openQty, openPrice);
        const orderPlan = await model['OrderPlan'].makeNew(planType, exchange, req.body, user);
        const subOrderInfos = await orderPlan.makeSubOrderInfos(req.body);
        await orderPlan.save({transaction:seqTransaction});
        await orderPlan.start(subOrderInfos, seqTransaction);
        await redisCtrl.pushQueue(`socket:parser`,
            `apiOrder||${orderPlan.exchange}||${orderPlan.userId}||${(orderPlan.isVirtual == true) ? 'virtual' : 'actual'}||${JSON.stringify({orderPlanId: orderPlan.id})}`);
        orderPlan.sendTelegramMessage('NEW').catch(e => {});
        return await next({status:'success', message: 'Your order request has been sent successfully'});
    }
    catch (e) {
        await seqTransaction.rollback();
        next(e);
    }
});

router.post('/modify', async (req, res, next) => {
    try {
        const orderPlanInfo = req.body;
        validateParameter(requiredKeyMap.orderinfo, orderPlanInfo);
        const orderPlanModel = await model['OrderPlan'].getOrderPlanWithSubOrdersById(req.body.orderPlanId);
        await orderPlanModel.modify(orderPlanInfo);
        return await next({status: 'success'});
    }catch (e) {
        next(e);
    }
});

router.post('/pause', async (req, res, next) => {
    try {
        if (!req.body.orderPlanId) throw new ParameterError(`orderPlanId`);
        const orderPlanModel = await model.OrderPlan.findByPk(req.body.orderPlanId);
        if(!orderPlanModel) {
            throw new OrderPlanNotExistError();
        }
        await orderPlanModel.pause();
        return await next({status: 'success'});
    }catch (e) {
        next(e);
    }
});

router.post('/resume', async (req, res, next) => {
    try {
        if (!req.body.orderPlanId) throw new ParameterError(`orderPlanId`);
        const orderPlanModel = await model['OrderPlan'].findByPk(req.body.orderPlanId);
        await model['OrderPlan'].checkUserOrdersCount(req.user, req.headers['exchange'], orderPlanModel.isVirtual);
        await model['OrderPlan'].checkExistOpposeDirectionOrderPlan(orderPlanModel.userId, orderPlanModel.planType,
                req.headers['exchange'], orderPlanModel.symbol, orderPlanModel.direction, orderPlanModel.isVirtual);
        await orderPlanModel.resume();
        return await next({status: 'success'});
    }catch (e) {
        next(e);
    }
});

router.post('/cancel', async (req, res, next) => {
    try {
        if (!req.body.orderPlanId) throw new ParameterError(`orderPlanId`);
        const orderPlanModel = await model['OrderPlan'].getOrderPlanWithSubOrdersById(req.body.orderPlanId);
        await orderPlanModel.cancel();
        return await next({status: 'success'});
    }catch (e) {
        next(e);
    }
});

router.post('/complete', async(req, res, next) => {
    try {
        validateParameter(requiredKeyMap['completeStrategy'], req.body);
        const orderPlanModel = await model['OrderPlan'].getOrderPlanWithSubOrdersById(req.body.orderPlanId);
        if(orderPlanModel.planType !== 'strategy') {
            throw new NotAllowedPlanTypeForApiError('complete API Strategy other than planType');
        }
        await orderPlanModel.complete(req.body.isMarketOrderNow);
        return await next({status: 'success'});
    }catch (e) {
        next(e);
    }
});

router.post('/sellMarketNow', async (req, res, next) => {
    try {
        if (!req.body.orderPlanId) throw new ParameterError(`orderPlanId`);
        const orderPlanModel = await model['OrderPlan'].findByPk(req.body.orderPlanId);
        await orderPlanModel.sellMarketNow();
        return await next({status: 'success'});
    }catch(e) {
        next(e);
    }
});

router.post('/stopAfterTrade', async (req, res, next) => {
    try {
        if (!req.body.orderPlanId) throw new ParameterError(`orderPlanId`);
        const orderPlanModel = await model['StrategyOrderPlan'].findByPk(req.body.orderPlanId);
        if(!orderPlanModel) {
            throw new OrderPlanNotExistError('Strategy stopAfterTrade OrderPlanModel undefined');
        }
        await orderPlanModel.stopAfterTrade();
        return await next({status: 'success'});
    }catch (e) {
        next(e);
    }
});


router.get('/getOrderDetail', async (req, res, next) => {
    try {
        const orderPlanId = req.query.orderPlanId;
        if(!orderPlanId) {
            throw new ParameterError(`orderPlanId`);
        }
        const orderInfo = await model['OrderPlan'].getModelWithTransactions(orderPlanId);
        return await next({status: 'success', data: orderInfo})
    }
    catch (e) {
        next(e);
    }
});

router.get('/completeOrderHistory', async (req, res, next) => {
    try {
        validateParameter(requiredKeyMap['completeOrderHistory'], req.query);
        const [completeOrderHistoryDatas, isLoadMore] = await model['OrderPlan'].getCompleteOrderPlansByPlanTypeAndSymbol(req.user.id, req.headers.exchange, req.query.planType, req.query.symbol, req.query.lastDate, req.query.isVirtual);
        return await next({status: 'success' , data  : completeOrderHistoryDatas, isLoadMore: isLoadMore});
    }catch (e) {
        next(e);
    }
});

router.get('/receipts', async (req, res, next) => {
    try {
        validateParameter(requiredKeyMap['receipts'], req.query);
        const exchange = req.headers.exchange;
        const user = req.user;
        const startDate = new Date(parseInt(req.query.startDate));
        const endDate = new Date(parseInt(req.query.endDate));
        const isVirtual = req.query.isVirtual == 'true' ? true : false;
        const pageSize = req.query.pageSize || 20;
        const pageNumber = req.query.pageNumber || 1;
        const symbol = req.query.symbol;
        const {count, data} = await model['Receipt'].getReceiptsByUserIdWithPagination(user.id, startDate, endDate, pageSize, pageNumber, exchange, isVirtual, symbol);
        return await next({status: 'success', count, data});
    }catch (e) {
        next(e);
    }
});

router.post('/pauseAll', async (req, res, next) => {
    try {
        const user = req.user;
        const exchange = req.headers.exchange;
        const isVirtual = req.body.isVirtual;
        const pauseReport = await model.OrderPlan.pauseAll(user, exchange, isVirtual);
        return await next({status: 'success', data: pauseReport});
    }catch (e) {
        next(e);
    }
});

router.post('/resumeAll', async (req, res, next) => {
    try {
        const user = req.user;
        const exchange = req.headers.exchange;
        const isVirtual = req.body.isVirtual;
        const resumeReport = await model.OrderPlan.resumeAll(user, exchange, isVirtual);
        return await next({status: 'success', data: resumeReport});
    }catch (e) {
        next(e);
    }
});

router.post('/clearing', async (req, res, next) => {
    const seqTransaction = await model.sequelize.transaction();
    try{
        const user = req.user;
        const exchange = req.headers.exchange;
        const symbol = req.body.symbol;
        const base = symbol.split('-')[0];
        const cancelReport = await model['OrderPlan'].cancelAllByUserIdAndAsset(user, exchange, base, base);

        const userBalance = {locked:0}
        const retryCount = 3;
        for(let i = 0 ; i < retryCount ; i++){
            Object.assign(userBalance, await redisCtrl.getUserBalance(user.id, exchange, base, false));
            if(userBalance.locked === 0){
                break;
            }
        }

        if(userBalance.locked > 0){
            throw new ClearingBatchSellFailed();
        }

        const orderPlanInfo = {
            symbol,
            direction: 'S2B',
            openInfo: [{
                enterPrice: '',
                qty: userBalance.free,
                side: 'SELL',
                tradeType: 'Market'
            }],
            takeProfitInfo: [],
            stopLossInfo: []
        }

        const orderPlan = await model['OrderPlan'].makeNew('basic', exchange, orderPlanInfo, user);
        const subOrderInfos = await orderPlan.makeSubOrderInfos(orderPlanInfo);
        await orderPlan.save({transaction:seqTransaction});
        await orderPlan.start(subOrderInfos, seqTransaction);
        await redisCtrl.pushQueue(`socket:parser`,
            `apiOrder||${orderPlan.exchange}||${orderPlan.userId}||${(orderPlan.isVirtual == true) ? 'virtual' : 'actual'}||${JSON.stringify({orderPlanId: orderPlan.id})}`);
        orderPlan.sendTelegramMessage('NEW').catch(e => {});
        return await next({status:'success', message: 'Your order request has been sent successfully', data: cancelReport});

    }catch (e) {
        await seqTransaction.rollback();
        next(e);
    }
})


module.exports = router;