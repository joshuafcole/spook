'use strict';

var Hapi = require('hapi');
var async = require('async');
var util = require('util');
var Spook = require('../lib/spook');
var db = require('../lib/db');
var io = require('../lib/io');
var pad = require('pad');
var path = require('path');
var mkdirp = require('mkdirp');
var minimist = require('minimist');
var glob = require('glob');
var fs = require('fs');
var gm = require('gm');
var concurrent = 1;
var q = async.queue(function (task, cb) {
  task(cb);
}, concurrent);

exports.act = function(request, reply) {
  db.run.findOne({SLUG: request.params.slug, NUM: parseInt(request.params.num, 10), ACT: { $exists: true }}, function (err, run) {
    if(!run || !io.room[run.SLUM]) {
      return reply.redirect('/' + path.join('job', request.params.slug, request.params.num));
    }
    var data = io.room[run.SLUM].data;

    reply.view('job/run', {
      tests: data.tests,
      run: data.run,
      job: data.job,
      msgs: io.room[run.SLUM].msgs
    });
  });
};


exports.list = function(request, reply) {

  var fns = [];
  db.job.find({}).sort({ SLUG: 1}).exec(function (err, jobs) {
    jobs.forEach(function(job){
      fns.push(function(cb){
        db.run.find({SLUG: job.SLUG, ACT: { $exists: false }}).sort({ NUM: -1 }).limit(5).exec(function (err, runs) {
          job.runs = runs;

          cb(null, job);
        });
      });
    });

    async.parallel(fns, function(err) {
      // console.log(jobs);
      // console.log(util.inspect(jobs, false, null));
      reply.view('job/list', {
        jobs: jobs
      });
    });
  });
};

exports.open = function(request, reply) {
  db.run.find({ACT: 1}).sort({ STA: -1 }).exec(function (err, runs) {
    reply.view('job/open', {
      runs: runs
    });
  });
};

exports.runs = function(request, reply) {
  async.parallel({
    job: function(cb){
      db.job.findOne({ SLUG: request.params.slug }, function (err, job) {
        cb(err, job);
      });
    },
    runs: function(cb){
      db.run.find({ SLUG: request.params.slug }).sort({ NUM: -1 }).exec(function (err, runs) {
        cb(err, runs);
      });
    }
  }, function(err, res){
    // console.log(util.inspect(res, false, null));

    if(!res.job) {
      return reply(Hapi.error.notFound('run not found'));
    }

    reply.view('job/runs', {
      job: res.job,
      runs: res.runs
    });
  });
};

exports.run = function(request, reply) {
  var run = {
    ACT: 1,
    STA: parseInt(+new Date() / 1000, 10)
  };
  var job;
  var mask;

  async.series({
    job: function(cb){
      db.job.findOne({ SLUG: request.params.slug }, function (err, doc) {
        job = doc;
        cb(err);
      });
    },
    run: function(cb) {
      // prepare a new run doc in the db
      db.run.count({ SLUG: request.params.slug }, function (err, count) {
        // console.log(err);
        run.NUM = ++count;
        mask = pad(4, run.NUM, '0');
        mask = path.join(mask.substr(0, 2), mask.substr(2));
        run.SLUG = request.params.slug;
        run.SLUM = run.SLUG + '-' + run.NUM;
        // shortcut to allow running route not to have to look up job each time
        // this document is entirely replaced once run completes
        run.ALIAS = job.ALIAS;
        db.run.insert(run, function(err, doc) {
          run = doc;
          cb(err);
        });
      });
    }
  }, function(err) {

    var argv = minimist(job.CMD.split(' '));
    argv.cwd = request.server.settings.app.cwd;
    argv.record = true;
    argv.out = path.join(request.server.settings.app.runPath, job.SLUG, mask);
    argv.work = 'parallel';
    mkdirp(argv.out, function (err) {

      argv.record = true;

      var spook = Spook(argv, function(err, res){
        if(err) {
          return reply(Hapi.error.internal(err));
        }
        var tests = res.tests;
        io.room[run.SLUM] = {
          data: {
            tests: tests,
            run: run,
            job: job
          },
          queued: true,
          msgs: []
        };

        // io.namespace.run[run.SLUM] = {
        //   server: io.server.of('/' + run.SLUM),
        //   data: {
        //     tests: tests,
        //     run: run,
        //     job: job
        //   },
        //   queued: true,
        //   msgs: []
        // };
        // io.namespace.run[run.SLUM].server.on('connection', function(socket){
        //   console.log('user join', run.SLUM);
        //   socket.on('disconnect', function(){
        //     console.log('user left', run.SLUM);
        //   });
        //   socket.on('run', function(msg){
        //     if(msg.action === 'kill') {
        //       spook.kill();
        //     }
        //   });
        // });


        argv.listener = function listener(msg){
          // io.namespace.run[run.SLUM].msgs.push(msg);
          // console.log(run.SLUM, 'emit ln');
          // io.namespace.run[run.SLUM].server.emit('run', msg);
          console.log('emit ln to', run.SLUM);
          io.room[run.SLUM].msgs.push(msg);
          io.server.in(run.SLUM).emit('run', msg);
        };

        // io.namespace.open.data[run.SLUM] = true;

        var task = function(qcb) {
          db.run.update({_id: run._id}, {$set: {STA: parseInt(+new Date() / 1000, 10)}}, function(err, doc) {
            // TODO inside here
          });
          // io.namespace.run[run.SLUM].queued = false;
          io.room[run.SLUM].queued = false;

          console.log('open emit', run.SLUM, 'STA');
          io.server.emit('open', {
            type: 'STA',
            SLUM: run.SLUM,
            open: Object.keys(io.room).length || 0
          });

          spook.run(function(err, res){
            res.NUM = run.NUM;
            res.SLUM = run.SLUM;
            res.SLUG = run.SLUG;
            db.run.update({SLUG:run.SLUG, NUM:run.NUM}, res, function(err, numReplaced, doc) {


              // io.namespace.run[run.SLUM].server.emit('run', {
              //   type: 'END',
              //   SLUM: run.SLUM,
              //   count: io.namespace.open.fn.count() - 1;
              // });
              // delete io.namespace.run[run.SLUM];
              delete io.room[run.SLUM];

              // delete io.namespace.open.data[run.SLUM];
              console.log('open emit', run.SLUM, 'END');
              io.server.emit('open', {
                type: 'END',
                SLUM: run.SLUM,
                open: Object.keys(io.room).length || 0
              });

              qcb();
              // make some images
              glob('*.jpg', {
                cwd: argv.out
              }, function (err, images) {
                var gms = [];
                if(images) {
                  images.forEach(function(img){
                    gms.push(function(cb){
                      var rs = fs.createReadStream(path.join(argv.out, img));
                      var ws = fs.createWriteStream(path.join(argv.out, 'thumb.' + img));
                      gm(rs)
                        .resize(200)
                        .stream()
                        .pipe(ws);
                      ws.on('close', function() {
                        cb();
                      });

                    });
                  });
                }
                async.parallelLimit(gms, 10, function(err) {
                  // all images done
                });
              });
            });
          });
        };

        // if((io.namespace.open.fn.count() - concurrent) >= concurrent) {
        //   io.namespace.run[run.SLUM].queued = true;
        // }

        reply.view('job/run', {
          queued: io.room[run.SLUM].queued,
          tests: tests,
          run: run,
          job: job,
          msgs: io.room[run.SLUM].msgs
        });

        setTimeout(function(){
          q.push(task);
        }, 1000);

      });
    });
  });
};
