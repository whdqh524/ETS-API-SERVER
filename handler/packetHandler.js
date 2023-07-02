'use strict';

const env = process.env.NODE_ENV || "development";
const etsSpotCommon = (env === 'product') ? require('@aitraum/ets-spot-common.git') : require('../../common');
const { logger, redisCtrl, error, config, utils } = etsSpotCommon;
const { USER_SESSION_EXPIRE_TIME } = etsSpotCommon.enum;
const model = (env === 'product') ? require('@aitraum/ets-spot-common.git/model') : require('../../common/model');
const { ParameterError, EtsError,NotFoundError404, TwoFactorAuthenticateError, AuthTokenExpiredError, TooManySameRequestError, UserEmailIsNotVeriedError} = error;
const exchange = (env === 'product') ? require('@aitraum/ets-spot-exchange-modules.git') : require('../../exchange');

// const {ADMIN_ACCOUNT} = require('../../config/enum'); ExchangeApiError


const passedUrlList = [
    `/getOhlc`,
    `/getOhlcFromDb`,
    `/getAllMarket`,
    `/getOhlc2`,
    '/signIn',
    '/signUp',
    '/validateEmail',
    '/validateUserName',
    '/updatePassword',
    '/sendAuthenticationMail',
    '/verifyEmailCodeForCheckEmail',
    '/verifyEmailCodeForUpdatePassword',
];

const getRequestUserName = (route, url) => {
    let routePath;
    if(route) {
        routePath = route.path;
    }
    else {
        routePath = url;
    }
    let pathSplitList = routePath.split('/').splice(1);
    let urlSplitList = url.split('/').splice(1);

    if(pathSplitList.length != urlSplitList.length) {
        urlSplitList = urlSplitList.splice(1);
    }
    let userUIDIndex = pathSplitList.indexOf(':username');
    return urlSplitList[userUIDIndex];
};

exports.validateParameter = function(checkArray, parameters) {
    const parmeterKeys = Object.keys(parameters);
    for(const key of checkArray) {
        if(!parmeterKeys.includes(key) || !parameters[key]) {
            throw new ParameterError(key);
        }
    }
};

exports.authHandler = async (req, res, next) => {
    try {
        if(passedUrlList.includes(req.url.split('?')[0])) {
            return next();
        }
        let userData = await redisCtrl.getUserSession(req.headers['token']);

        if(!userData) throw new AuthTokenExpiredError();

        const userModel = model['User'].build(userData);
        userModel.isNewRecord = false;
        await userModel.reload();
        req.user = userModel;
        await redisCtrl.setUserSession(req.headers['token'], userData, USER_SESSION_EXPIRE_TIME);
        const inputUrl = req.originalUrl.split('?')[0];
        if(!inputUrl.match('getOhlc')) {
            await logger.infoConsole(`[Input] ${userData.userName} - ${inputUrl}`,
                {query: req.query, params:req.params, body: req.body});
            const packetSession = await redisCtrl.getPacketSession(`${userData.userName}-${inputUrl}`);
            if(packetSession) {
                throw new TooManySameRequestError();
            }
        }
        next();
    }
    catch (e) {
        next(e);
    }
};

exports.exchangeHandler = async (req, res, next) => {
    try {
        if(!req.headers['exchange'] || !config.exchangeList.includes(req.headers['exchange'])) {
            throw new ParameterError('exchange');
        }
        next();
    }   
    catch (e) {
        next(e);
    }
};

exports.errorHandler = async (result, req, res, next) => {
    if(!(result instanceof Error) && result['status']) {
        const inputUrl = req.originalUrl.split('?')[0];
        if(!inputUrl.match('getOhlc')) {
            await logger.infoConsole(`[Output] ${(req.user && req.user.userName) ? req.user.userName : 'public'} - ${inputUrl}`,
                {query: req.query, params:req.params, body: req.body});
        }
        return await res.json(result);
    }

    let clientIp = '';

    if(req.headers['x-forwarded-for']) {
        clientIp = req.headers['x-forwarded-for'].split(',')[0];
    }
    const errorContent = {
        serverIp: serverIp,
        clientIp: clientIp,
        exchange : req.headers.exchange ? req.headers.exchange : 'public',
        userAgent: req.headers['user-agent'],
    };
    let errorType;

    if(result instanceof Error) {
        if(result.status === 404) {
            res.status(404).send("404 Not Found");
            const error = new NotFoundError404(result);
            return await logger.error(error, errorContent);
        }
        if(req.headers.exchange && result instanceof exchange[req.headers.exchange]['Error'].ExchangeApiError) errorType = req.headers.exchange.toUpperCase();
        if(result instanceof EtsError) {
            if(result.constructor.name == 'NeedGoogleOTPVerifyError') {
                return await res.json({status: 'needAuthentication', factor: 'googleOTP'});
            }
            if(result.constructor.name == 'NeedUserEmailVerifyError') {
                return await res.json({status: 'needAuthentiacation', factor: 'email'});
            }
            const returnForm = {
                status: "fail",
                code: result.code
            };
            const slackContent = {
                userId:  req.user ? req.user.id : undefined,
                userName: req.user ? req.user.userName : undefined,
            };

            if(result.hasOwnProperty('params')) returnForm['params'] = result.params;
            await res.status(400).json(returnForm);
            return await logger.error(result, errorContent, slackContent, errorType);
        }
        await res.status(400).json({
            status: "fail",
            code: "10000",
            message: (result.name) ? result.name : "UnknownError",
            trace: (result.desc) ? result.desc : result.message
        });
        return await logger.error(result, errorContent);
    }
};

let serverIp, os = require('os'), ifaces = os.networkInterfaces();

for (let dev in ifaces) {

    let iface = ifaces[dev].filter(function(details) {
        return details.family === 'IPv4' && details.internal === false;
    });

    if(iface.length > 0) serverIp = iface[0].address;
}