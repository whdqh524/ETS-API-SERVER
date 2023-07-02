"use strict";

let { Router } = require('express');
let router = Router();
const env = process.env.NODE_ENV || "development";
const etsSpotCommon = (env === 'product') ? require('@aitraum/ets-spot-common.git') : require('../../common');
const exchangeModules = (env === 'product') ? require('@aitraum/ets-spot-exchange-modules.git') : require('../../exchange');
const model = (env === 'product') ? require('@aitraum/ets-spot-common.git/model') : require('../../common/model');
const { config, redisCtrl} = etsSpotCommon;
const { ParameterError } = etsSpotCommon.error;
const { authHandler, exchangeHandler } = require('../handler/packetHandler');



const requiredKeyMap = {
    pubilc: ['symbol'],
    ohlc: ['period'],
    ohlcFromDb: ['period', 'count'],
};

router.use(authHandler);
router.use(exchangeHandler);

router.get('/getAllBaseExchangeRate', async (req, res, next) => {
    try {
        const result = await redisCtrl.getAllBaseExchangeRate(req.headers.exchange);
        return await next({status:'success', data:result});
    }
    catch (e) {
        next(e);
    }
});

router.get('/getAllMarketData', async (req, res, next) => {
    try {
        const exchangeApi = new exchangeModules[req.headers.exchange].Api();
        const result = await exchangeApi.getAllMarket();
        return await next({status: 'success', data: result});
    }
    catch (e) {
        next(e);
    }
});

router.get('/getOhlc', async (req, res, next) => {
   try {
       const reqKeys = Object.keys(req.query);
       const requiredKeyList = requiredKeyMap.pubilc.concat(requiredKeyMap['ohlc']);
       for(let key of requiredKeyList) {
           if(!reqKeys.includes(key)) {
               throw new ParameterError(key);
           }
       }
       const symbol = req.query.symbol;
       const period = req.query.period;
       const count = req.query.count ? parseInt(req.query.count) : undefined;
       const startDate = req.query.startDate ? parseInt(req.query.startDate) : undefined;
       const endDate = req.query.endDate? parseInt(req.query.endDate) : new Date().getTime();
       const exchangeApi = new exchangeModules[req.headers.exchange].Api();
       const result = await exchangeApi.getOhlcHistory(symbol, period, startDate, endDate, count);
       return await next({status:'success', data:result});
   }
   catch (e) {
        next(e);
   }
});

router.get('/getOhlcFromDb', async (req, res, next) =>{
    try {
        const reqKeys = Object.keys(req.query);
        const requiredKeyList = requiredKeyMap.pubilc.concat(requiredKeyMap['ohlcFromDb']);
        for(let key of requiredKeyList) {
            if(!reqKeys.includes(key)) {
                throw new ParameterError(`Requied Parameter - ${key} was not sent`);
            }
        }
        const exchangeName = req.headers.exchange;
        const symbol = req.query.symbol;
        const period = req.query.period;
        const count = parseInt(req.query.count);
        const endDate = parseInt(req.query.endDate);
        const nowDate = new Date().getTime();
        const ohlcCollection = model[exchangeName].collection(`${exchangeName}_${symbol}_${period}`);
        let ohlcList;
        let ohlcQuery;
        ohlcQuery = !endDate ? {"$lte":nowDate} : {"$lt":endDate};
        ohlcList = await new Promise((resolve, reject) => {
            ohlcCollection.find({"_id":ohlcQuery})
                .sort({"_id":-1})
                .limit(count)
                .toArray(function(err, docs) {
                    if(err) return reject(err);
                    const result = docs.map(doc => {
                        return [
                            doc.value[0],
                            doc.value[1],
                            doc.value[2],
                            doc.value[3],
                            doc.value[4],
                            doc.value[5]
                        ]
                    });
                    resolve(result);
                })
        });

        return await next({status:'success', data: ohlcList});
    }catch (e) {
        next(e)
    }
});

module.exports = router;
