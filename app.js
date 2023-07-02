'use strict';

const createError = require('http-errors');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const logger = require('morgan');
const { errorHandler } = require('./handler/packetHandler');

const usersRouter = require('./routes/users');
const exchangeRouter = require('./routes/exchange');
const orderRouter = require('./routes/order');
const strategyRouter = require('./routes/strategy');
const noticeRouter = require('./routes/notice');

const app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(require('express-domain-middleware'));
let crosOptions = {};
if(process.env.NODE_ENV === 'product') crosOptions = {origin: 'https://trade.coinbutler.net', credentials: true};
app.use(cors(crosOptions));
app.disable('etag');

app.use('/users', usersRouter);
// app.use('/login', loginRouter);
app.use('/exchange', exchangeRouter);
app.use('/order', orderRouter);
app.use('/strategy', strategyRouter);
app.use('/notice', noticeRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  if(req.url === '/' || req.uri === '/') {
    res.send('OK');
    return;
  }
  console.log(req.url);
  next(createError(404));
});

// error handler
app.use(errorHandler);

module.exports = app;
