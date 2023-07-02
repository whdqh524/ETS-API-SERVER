"use strict";

let { Router } = require('express');
let router = Router();
const env = process.env.NODE_ENV || "development";
const etsSpotCommon = (env === 'product') ? require('@aitraum/ets-spot-common.git') : require('../../common');
const { ParameterError, StrategyNotExistError, AlreadyOngoingStrategyError, StrategyCountRestrictionError } = etsSpotCommon.error;
const { ORDER_ALIVE, ONGOING_ORDER_LIMIT } = etsSpotCommon.enum;
const model = (env === 'product') ? require('@aitraum/ets-spot-common.git/model') : require('../../common/model');

const { authHandler, validateParameter } = require('../handler/packetHandler');

const requiredKeyMap = {
    saveStrategy: ['openInfo', 'takeProfitInfo', 'stopLossInfo', 'name'],
};

router.use(authHandler);


router.post('/save', async (req, res, next) => {
    try {
        const strategyInfo = req.body;
        validateParameter(requiredKeyMap.saveStrategy, strategyInfo);
        let strategyModel;
        if(strategyInfo.strategyId) {
            strategyModel = await model['Strategy'].findByPk(strategyInfo.strategyId);
            await strategyModel.modify(strategyInfo)
        }
        else {
            const strategyCount = await model['Strategy'].count({where: {userId: req.user.id, isAlive:true}});
            if(strategyCount >= ONGOING_ORDER_LIMIT) {
                throw new StrategyCountRestrictionError();
            }
            strategyModel = await model['Strategy'].makeNew(strategyInfo, req.user, req.headers.exchange);
        }
        await next({status: 'success', message:'Make Strategy Complete', data: strategyModel.convertReturnForm()});
    }
    catch (e) {
        next(e);
    }
});

router.get('/getList', async (req, res, next) => {
   try {
       const strategyList = await model['Strategy'].getStrategyListByUserId(req.user.id);
       await next({status: 'success', data: strategyList});
   }
   catch (e) {
       next(e);
   }
});

router.post('/remove', async (req, res, next) => {
   try {
       const strategyId = req.body.strategyId;
       if(!strategyId) {
           throw new ParameterError(`StrategyId`);
       }
       const strategyModel = await model['Strategy'].findByPk(strategyId);
       if(!strategyModel) {
           throw new StrategyNotExistError('Remove StrategyModel Undefined');
       }
       const orderPlans = await model['OrderPlan'].findAll({
           where: {
               strategyId: strategyId,
               active: ORDER_ALIVE.ACTIVE
           }
       });
       if(orderPlans.length > 0) {
           throw new AlreadyOngoingStrategyError('Remove orderPlans Activated');
       }
       await strategyModel.removeStrategy();
       await next({status:'success'})
   }
   catch (e) {
       next(e);
   }
});

router.post('/modifyName', async (req, res, next)=>{
    try {
        const strategyId = req.body.strategyId;
        if(!strategyId) {
            throw new ParameterError(`StrategyId`);
        }
        const strategyModel = await model['Strategy'].findByPk(strategyId);
        if(!strategyModel) {
            throw new StrategyNotExistError('modifyName StrategyModel Undefined');
        }
        strategyModel.name = req.body.strategyName;
        await strategyModel.save();
        const orderPlan = await model['OrderPlan'].findOne({where: {strategyId: strategyModel.id}});
        if(orderPlan){
            orderPlan.strategyName = req.body.strategyName;
            await orderPlan.save();
        }
        await next({status: 'success'});
    }catch (e){
        next(e);
    }
});

module.exports = router;