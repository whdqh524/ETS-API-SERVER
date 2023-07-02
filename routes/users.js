"use strict";

let { Router } = require('express');
let router = Router();
const axios = require('axios');
const env = process.env.NODE_ENV || "development";
const uuidv4 = require('uuid').v4;
const exchange = (env === 'product') ? require('@aitraum/ets-spot-exchange-modules.git') : require('../../exchange');
const model = (env === 'product') ? require('@aitraum/ets-spot-common.git/model') : require('../../common/model');
const etsSpotCommon = (env === 'product') ? require('@aitraum/ets-spot-common.git') : require('../../common');
const { utils, config, error, redisCtrl, mailer, logger} = etsSpotCommon;
const { USER_SESSION_EXPIRE_TIME, USER_TEMP_SESSION_EXPIRE_TIME } = etsSpotCommon.enum;
const { randomString, retryWrapper } = utils;

const { TelegramIDNotFoundError, TelegramIDNotStartedError, ParameterError, NotFindUserError, InvalidTelegramIDError, InvalidCheckPassword, FavoriteLimitExceed, TelegramServerRequestTimeOutError, TelegramServerError } = error;
const { authHandler, validateParameter } = require('../handler/packetHandler');


router.use(authHandler);

const requiredKeyMap = {
    signUp: ['email','password','country','timezone', 'timezoneString'],
    virtualSignUp: ['email', 'password'],
    signIn:['email', 'password'],
    updateApiKey: ['apiKey', 'secretKey'],
    sendAuthenticationMail: ['email', 'mailType'],
    verifyEmailCode: ['email', 'emailCode'],
    updateTelegram: ['telegramId'],
    updateLanguage: ['language'],
    updatePassword: ['updatePasswordToken','password'],
    signOut: ['password'],
    modifyUserInformation: ['userName', 'country', 'timezone', 'timezoneString'],
    initApiKeyAndRecovery: ['exchange'],
    checkUpdatePassword: ['password', 'newPassword'],
    googleOTP: ['password', 'otpCode'],
};


router.post('/signIn', async (req, res, next) => {
    try {
        let userModel, token;
        if(req.body.token || req.headers.token) {
            token = req.body.token || req.headers.token;
            userModel = await model['User'].signInByToken(token);
        }
        else{
            const checkArray = requiredKeyMap['signIn'];
            validateParameter(checkArray, req.body);
            token = randomString();
            userModel = await model['User'].signInByEmailAndPassword(req.body.email, req.body.password, req.body.otpCode);
        }
        await redisCtrl.setUserSession(token, userModel, USER_SESSION_EXPIRE_TIME);
        return await next({status: 'success', token: token, user:userModel.convertInfoForm()});

    }catch (e) {
        next(e);
    }
});

router.post('/signUp', async (req, res, next) => {
    try {
        const checkArray = requiredKeyMap['signUp'];
        validateParameter(checkArray, req.body);
        const user = await model['User'].makeNew(req.body);
        await user.save();
        for(const exchangeName of config.exchangeList) {
            const exchangeApi = new exchange[exchangeName].Api();
            await exchangeApi.initVirtualBalances(user.id);
        }
        return await next({status: 'needAuthentication', factor: 'email'});
    }catch (e) {
        next(e);
    }
});

router.post('/logOut', async (req, res, next) => {
    try {
        await redisCtrl.delUserSession(req.headers['token']);
        await logger.info('USER','LOGOUT',{type: 'USER_ACCESS', user: req.user},'-');
        return await next({status: 'success'});
    }
    catch (e) {
        next(e);
    }
});

router.post('/signOut', async (req, res, next)=>{
    try {
        validateParameter(requiredKeyMap.signOut, req.body);
        const userModel = req.user;
        await userModel.signOut(req.body.password, req.body.otpCode, req.headers.token, req.body.reason, req.body.reasonDetail);
        return next({status: 'success'});
    }
    catch (e) {
        if(e.constructor.name == 'NeedGoogleOTPVerifyError') {
            return await next({status: 'needAuthentication', factor: 'googleOTP'});
        }
        if(e.constructor.name == 'EmailVerifiedError') {
            return await next({status: 'needAuthentiacation', factor: 'email'})
        }
        next(e);
    }
});


router.post('/validateEmail',async (req, res, next)=>{
    try {
        if (!req.body.email) throw new ParameterError(`email`);
        await model['User'].validateEmail(req.body.email);
        return await next({status: 'success'})
    }catch (e) {
        next(e);
    }
});

router.post('/validateUserName',async (req, res, next)=>{
    try {
        if (!req.body.userName) throw new ParameterError(`userName`);
        await model['User'].validateUserName(req.body.userName);
        return await next({status: 'success'})
    }catch (e) {
        next(e);
    }
});

router.post('/verifyTelegram', async (req, res, next) => {
    try {
        if (!req.body.telegramId) throw new ParameterError(`telegramId`);
        const idReg = /^[A-za-z0-9_]*$/;
        if(!idReg.test(req.body.telegramId)) {
            throw new InvalidTelegramIDError();
        }
        const options = {
            eventType:  'userCheck',
            serviceName: 'CoinButler_Bot',
            telegramId : req.body.telegramId,
            uuid: uuidv4(),
        };
        await retryWrapper(redisCtrl.pushTelegramQueue, JSON.stringify(options));
        console.log('API Server  UUID'+options.uuid);
        const response = await retryWrapper(redisCtrl.listenTelegramResponse, options.uuid, 5);
        if(!response) throw new TelegramServerRequestTimeOutError();
        const responseValue = JSON.parse(response);
        if(responseValue.status !== 'success') {
            if(responseValue.message === 'NotFoundTelegramChatId') {
                throw new TelegramIDNotFoundError();
            }
            else if(responseValue.message === 'NotStartedTelegramChatId') {
                throw new TelegramIDNotStartedError();
            }else{
                throw new TelegramServerError();
            }
        }
        const userModel = req.user;
        userModel.telegram = req.body.telegramId;
        await userModel.save();
        await redisCtrl.setUserSession(req.headers.token, userModel, USER_SESSION_EXPIRE_TIME);
        return next({status: 'success', user: userModel.convertInfoForm()});
    }
    catch (e) {
        next(e);
    }
});

router.post('/updateLanguage', async (req, res, next)=>{
    try {
        validateParameter(requiredKeyMap.updateLanguage, req.body);
        const userModel = req.user;
        userModel.language = req.body.language;
        await userModel.save();
        await redisCtrl.setUserSession(req.headers.token, userModel, USER_SESSION_EXPIRE_TIME);
        return next({status: 'success', user: userModel.convertInfoForm()});
    }catch (e) {
        next(e)
    }
});

router.post('/updateTelegram', async (req, res, next)=>{
    try {
        validateParameter(requiredKeyMap.updateTelegram, req.body);
        const userModel = req.user;
        userModel.telegram = req.body.telegramId;
        await userModel.save();
        await redisCtrl.setUserSession(req.headers.token, userModel, USER_SESSION_EXPIRE_TIME);
        return next({status: 'success', user: userModel.convertInfoForm()});
    }catch (e) {
        next(e)
    }
});

router.post('/deleteTelegram', async (req, res, next) => {
    try {
        const userModel = req.user;
        userModel.telegram = '';
        await userModel.save();
        await redisCtrl.setUserSession(req.headers.token, userModel, USER_SESSION_EXPIRE_TIME);
        return next({status: 'success', user: userModel.convertInfoForm()});
    }
    catch (e) {
        next(e);
    }
});

router.post('/updateApiKey', async (req, res, next) => {
    try {
        validateParameter(requiredKeyMap.updateApiKey, req.body);
        if(!req.headers['exchange'] || !config.exchangeList.includes(req.headers['exchange'])) {
            throw new ParameterError('exchange');
        }
        const userModel = req.user;
        await userModel.verifyGoogleOTP(req.body.otpCode);
        const exchangeApi = new exchange[req.headers['exchange']].Api();
        exchangeApi.apiKey = req.body.apiKey;
        exchangeApi.secretKey = req.body.secretKey;
        if(req.body.passphrase) {
            exchangeApi.passphrase = req.body.passphrase;
        }
        await exchangeApi.checkApi();
        await userModel.updateApiKey(req.headers.exchange, req.body.apiKey, req.body.secretKey, req.body.passphrase);
        await redisCtrl.setUserSession(req.headers.token, userModel, USER_SESSION_EXPIRE_TIME);
        return await next({status: 'success', user: userModel.convertInfoForm()});
    }catch (e) {
        next(e);
    }
});


router.get('/getExchangeOrderHistory', async (req, res, next) => {
    try {
        const user = req.user;
        if(!req.headers['exchange'] || !config.exchangeList.includes(req.headers['exchange'])) {
            throw new ParameterError('exchange');
        }
        if (!user.apiKeyMap || user.apiKeyMap[req.headers['excahnge']]) return await next({status: 'success',data: []});
        const exchangeClass = new exchange[req.headers['exchange']]['Api'](user);
        const orderHistory = await exchangeClass.getOrderHistory(req.query.symbol, req.query.count);
        return await next({status: 'success', data: orderHistory});
    } catch(e){
        next(e);
    }
});


router.post('/updatePassword', async (req, res, next)=>{
   try {
       validateParameter(requiredKeyMap.updatePassword, req.body);
       await model['User'].updatePassword(req.body.updatePasswordToken, req.body.password);
       return await next({status: 'success'});
   }catch (e) {
       next(e);
   }
});

router.post('/sendAuthenticationMail', async (req, res, next)=>{
    try {
        validateParameter(requiredKeyMap.sendAuthenticationMail, req.body);
        await model['User'].sendAuthenticationMail(req.body.email, req.body.mailType);
        const tokenExpireTime = new Date().getTime() + (1000 * USER_TEMP_SESSION_EXPIRE_TIME);
        return await next({status: 'success', tokenExpireTime: tokenExpireTime});
    }
    catch (e) {
        next(e)
    }
});

router.post('/verifyEmailCodeForCheckEmail', async (req, res, next)=>{
    try {
        validateParameter(requiredKeyMap.verifyEmailCode, req.body);
        const user = await model['User'].findOne({where:{email: req.body.email}});
        if(!user) {
            throw new NotFindUserError();
        }
        await user.verifyAuthenticationMail(req.body.emailCode, 'REGISTER_AUTHENTICATION');
        user.emailVerified = true;
        user.lastLogin = new Date();
        await user.save();
        const token = randomString();
        await redisCtrl.setUserSession(token, user, USER_SESSION_EXPIRE_TIME);
        await mailer.sendEmail(user.email, 'REGISTER_COMPLETED', user.language);
        return await next({status: 'success', token: token, user: user.convertInfoForm()});
    }
    catch (e) {
        next(e);
    }
});

router.post('/verifyEmailCodeForUpdatePassword', async (req, res, next) => {
    try {
        validateParameter(requiredKeyMap.verifyEmailCode, req.body);
        const user = await model['User'].findOne({where:{email: req.body.email}});
        if(!user) {
            throw new NotFindUserError();
        }
        await user.verifyAuthenticationMail(req.body.emailCode, 'PASSWORD_AUTHENTICATION');

        const token = randomString();
        await redisCtrl.setUserSession(token, user.id, USER_TEMP_SESSION_EXPIRE_TIME, 'update_password');
        return await next({status: 'success', updatePasswordToken: token})
    }
    catch (e) {
        next(e);
    }
});

router.post('/generateGoogleOTPData', async (req, res, next)=>{
    try {
        const userModel = req.user;
        const googleOtpData = await userModel.generateGoogleOTPData();
        return await next({status: 'success', data: googleOtpData});
    }
    catch (e) {
        next(e);
    }
});


router.post('/activateGoogleOTP', async (req, res, next)=>{
    try {
        validateParameter(requiredKeyMap.googleOTP, req.body);
        const userModel = req.user;
        if(!userModel.validatePassword(req.body.password)) throw new InvalidCheckPassword();
        await userModel.activateGoogleOTP(req.body.otpCode);
        await redisCtrl.setUserSession(req.headers.token, userModel, USER_SESSION_EXPIRE_TIME);
        return await next({status: 'success', user: userModel.convertInfoForm()});
    }
    catch (e) {
        next(e);
    }
});

router.post('/deactivateGoogleOtp', async (req, res, next) => {
    try {
        validateParameter(requiredKeyMap.googleOTP, req.body);
        const userModel = req.user;
        if(!userModel.validatePassword(req.body.password)) throw new InvalidCheckPassword();
        await userModel.deactivateGoogleOTP(req.body.otpCode);
        await redisCtrl.setUserSession(req.headers.token, userModel, USER_SESSION_EXPIRE_TIME);
        return await next({status: 'success', user: userModel.convertInfoForm()});
    }
    catch (e) {
        next(e);
    }
});

router.get('/getAllBalances', async (req, res, next) => {
    try {
        if(!req.headers.exchange || !config.exchangeList.includes(req.headers.exchange)) {
            throw new ParameterError(`exchange`);
        }
        const balanceDatas = await redisCtrl.getUserAllBalance(req.headers.exchange, req.user.id);
        return await next({status: 'success', data: balanceDatas});
    }
    catch (e) {
        next(e);
    }
});

router.get('/getOrderPlanCount', async (req, res, next) => {
    try {
        let isVirtual = (req.query.isVirtual == 'true') ? true : (req.query.isVirtual == 'false') ? false : undefined;
        if(isVirtual == undefined) {
            throw new ParameterError(`isVirtual`);
        }
        const userModel = req.user;
        const [planTypeMap, symbolMap] = await userModel.getOrderPlanHistoryToMap(isVirtual);
        return await next({status: 'success', planTypeMap: planTypeMap, symbolMap: symbolMap});
    }
    catch (e) {
        next(e);
    }
});

router.post('/modifyUserInformation', async(req, res, next) => {
    try {
        validateParameter(requiredKeyMap.modifyUserInformation, req.body);
        const userModel = req.user;
        await userModel.modifyUserInformation(req.body.userName, req.body.country, req.body.timezone, req.body.timezoneString);
        await redisCtrl.setUserSession(req.headers.token, userModel, USER_SESSION_EXPIRE_TIME);
        return await next({status: 'success', user: userModel.convertInfoForm()});
    }
    catch (e) {
        next(e);
    }
});

router.post('/modifyNotificationInformation', async(req, res, next) => {
    try {
        if(!req.body.language) {
            throw new ParameterError(`language`);
        }
        if(!(req.body.receiveMarketingInfo == true || req.body.receiveMarketingInfo == false)) {
            throw new ParameterError(`receiveMarketingInfo`);
        }
        const userModel = req.user;
        await userModel.modifyNotificationInformation(req.body.language, req.body.receiveMarketingInfo, req.body.telegram);
        await redisCtrl.setUserSession(req.headers.token, userModel, USER_SESSION_EXPIRE_TIME);
        return await next({status: 'success', user: userModel.convertInfoForm()});
    }
    catch (e) {
        next(e);
    }
});

router.post('/modifyReceiveMarketingInfo', async(req, res, next) => {
    try {
        if(!(req.body.receiveMarketingInfo == true || req.body.receiveMarketingInfo == false)) {
            throw new ParameterError(`receiveMarketingInfo`);
        }
        const userModel = req.user;
        userModel.receiveMarketingInfo = req.body.receiveMarketingInfo;
        await userModel.save();
        await redisCtrl.setUserSession(req.headers.token, userModel, USER_SESSION_EXPIRE_TIME);
        return await next({status: 'success', user: userModel.convertInfoForm()});
    }
    catch (e) {
        next(e)
    }
});

router.post('/initApiKeyAndRecovery', async(req, res, next) => {
    try {
        validateParameter(requiredKeyMap.initApiKeyAndRecovery, req.body);
        await req.user.initializeApiKeyAndRecoveryStatus(req.body.exchange);
        return await next({status: 'success'});
    }
    catch (e) {
        next(e);
    }
});


router.post('/checkPassword', async (req, res, next)=>{
    try {
        if(!req.body.password) throw new ParameterError('password');
        if(!req.user.validatePassword(req.body.password)){
            throw new InvalidCheckPassword();
        }
        return await next({status: 'success'});
    }catch (e){
        next(e);
    }
});

router.post('/checkUpdatePassword', async (req, res, next)=>{
    try {
        validateParameter(requiredKeyMap.checkUpdatePassword, req.body);
        const userModel = req.user;
        if(!userModel.validatePassword(req.body.password)) throw new InvalidCheckPassword();
        userModel.password = req.body.newPassword;
        userModel.save();
        await logger.info('USER','MODIFY',{user: req.user, type: 'USER_INFORMATION'},'updatedPassword');
        return await next({status: 'success'});
    }catch (e){
        next(e);
    }
});

router.post('/setUserFavoriteSymbols', async (req, res, next) => {
    try {
        if(!req.headers.exchange || !config.exchangeList.includes(req.headers.exchange)) {
            throw new ParameterError(`exchange`);
        }

        if(!req.body.symbols) {
            throw new ParameterError(`symbols`);
        }
        const symbols = Array.isArray(req.body.symbols) ? req.body.symbols : [req.body.symbols];
        const beforeSymbolCount = await redisCtrl.getUserFavoriteSymbolCount(req.headers.exchange, req.user.id);

        const limit = 50;
        if(beforeSymbolCount + symbols.length > limit){
            throw new FavoriteLimitExceed();
        }

        const result = await redisCtrl.setUserFavoriteSymbols(req.headers.exchange, req.user.id, symbols);
        return await next({status: 'success', successCount: result});
    }
    catch (e) {
        next(e);
    }
});

router.get('/getUserFavoriteSymbols', async (req, res, next) => {
    try {
        if(!req.headers.exchange || !config.exchangeList.includes(req.headers.exchange)) {
            throw new ParameterError(`exchange`);
        }

        const result = await redisCtrl.getUserFavoriteSymbols(req.headers.exchange, req.user.id);
        return await next({status: 'success', favorites: result});
    }
    catch (e) {
        next(e);
    }
});

router.post('/deleteUserFavoriteSymbols', async (req, res, next) => {
    try {
        if(!req.headers.exchange || !config.exchangeList.includes(req.headers.exchange)) {
            throw new ParameterError(`exchange`);
        }

        if(!req.body.symbols) {
            throw new ParameterError(`symbols`);
        }

        const result = await redisCtrl.deleteUserFavoriteSymbols(req.headers.exchange, req.user.id, req.body.symbols);
        return await next({status: 'success', successCount: result});
    }
    catch (e) {
        next(e);
    }
});
module.exports = router;



