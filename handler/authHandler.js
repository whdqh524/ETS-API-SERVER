'use strict';

const axios = require('axios');
const env = process.env.NODE_ENV || "development";
const model = (env === 'product') ? require('@aitraum/ets-spot-common.git/model') : require('../../common/model');
const {config, error, redisCtrl} = (env === 'product') ? require('@aitraum/ets-spot-common.git') : require('../../common');
const {InvalidTokenError, AuthStatusError, ParameterError} = error;


module.exports.check = async (req) => {
    let authToken;
    if(req.headers['token'] && req.headers['token'] != ''){
        authToken = req.headers['token'];
    }
    if(req.body['token']) {
        authToken = req.body['token'];
    }
    if(!authToken) {
        throw new ParameterError('token')
    }
    const options = {
        headers: {
            'content-type' : 'application/json',
            'Accept': 'application/json',
        },
        method: 'POST',
        url:config.ssoServer.uri,
        data: JSON.stringify({"_token":authToken})
    };

    let results;
    try {
        results = await axios(options);
    }
    catch (e) {
        throw new AuthStatusError(`auth Server is not working`);
    }

    let data = results.data;
    if(!data.result){
        throw new InvalidTokenError();
        // if(data.status == -1) {
        //     throw new AuthStatusInvalidTokenError(`Invalid token`);
        // } else if(data.status == -2) {
        //     throw new AuthStatusNotFindUserError(`Not find user`);
        // } else if(data.status == -3) {
        //     throw new AuthStatusNeedApiKeyError(`Need lib api key at least one`);
        // } else if(data.status == -4) {
        //     throw new AuthStatusNotAllowedServiceError(`User is not allowed mts service`);
        // }
    }
    if(!data['userProfile']) {
        throw new AuthStatusError(`Not find User Data`);
    }
    let user = await model['User'].findOne({where:{userName: data['userProfile'].userName}});
    return {user: user, authData: data, authToken:authToken};
};

module.exports.checkLocal = async(req) => {

};