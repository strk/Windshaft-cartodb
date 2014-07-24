var assert      = require('../support/assert');
var tests       = module.exports = {};
var _           = require('underscore');
var redis       = require('redis');
var querystring = require('querystring');
var semver      = require('semver');
var mapnik      = require('mapnik');
var Step        = require('step');
var strftime    = require('strftime');
var SQLAPIEmu   = require(__dirname + '/../support/SQLAPIEmu.js');
var redis_stats_db = 5;

var helper = require(__dirname + '/../support/test_helper');

var windshaft_fixtures = __dirname + '/../../node_modules/windshaft/test/fixtures';

var CartodbWindshaft = require(__dirname + '/../../lib/cartodb/cartodb_windshaft');
var ServerOptions = require(__dirname + '/../../lib/cartodb/server_options');
serverOptions = ServerOptions();
var server = new CartodbWindshaft(serverOptions);
server.setMaxListeners(0);

var IMAGE_EQUALS_TOLERANCE_PERCENT = 2;

suite('multilayer', function() {

    var redis_client = redis.createClient(global.environment.redis.port);
    var sqlapi_server;
    var expected_last_updated_epoch = 1234567890123; // this is hard-coded into SQLAPIEmu
    var expected_last_updated = new Date(expected_last_updated_epoch).toISOString();

    var test_user = _.template(global.environment.postgres_auth_user, {user_id:1});
    var test_pubuser = global.environment.postgres.user;
    var test_database = test_user + '_db';

    suiteSetup(function(done){
      sqlapi_server = new SQLAPIEmu(global.environment.sqlapi.port, done);
    });

    test("layergroup with 2 layers, each with its style", function(done) {

      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: 'select cartodb_id, ST_Translate(the_geom_webmercator, 5e6, 0) as the_geom_webmercator from test_table limit 2',
               cartocss: '#layer { marker-fill:red; marker-width:32; marker-allow-overlap:true; }', 
               cartocss_version: '2.0.1',
               interactivity: 'cartodb_id'
             } },
           { options: {
               sql: 'select cartodb_id, ST_Translate(the_geom_webmercator, -5e6, 0) as the_geom_webmercator from test_table limit 2 offset 2',
               cartocss: '#layer { marker-fill:blue; marker-allow-overlap:true; }', 
               cartocss_version: '2.0.2',
               interactivity: 'cartodb_id'
             } }
        ]
      };

      var expected_token; // = "e34dd7e235138a062f8ba7ad051aa3a7";
      Step(
        function do_post()
        {
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: JSON.stringify(layergroup)
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              var parsedBody = JSON.parse(res.body);
              var expectedBody = { layergroupid: expected_token };
              // check last modified
              var qTables = JSON.stringify({
                'q': 'SELECT CDB_QueryTables($windshaft$'
                    + layergroup.layers[0].options.sql + ';'
                    + layergroup.layers[1].options.sql 
                    + '$windshaft$)'
              });
              assert.equal(parsedBody.last_updated, expected_last_updated);
              if ( expected_token ) {
                assert.equal(parsedBody.layergroupid, expected_token + ':' + expected_last_updated_epoch);
              }
              else expected_token = parsedBody.layergroupid.split(':')[0];
              next(null, res);
          });
        },
        function do_get_tile(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token + ':cb0/0/0/0.png32',
              method: 'GET',
              headers: {host: 'localhost' },
              encoding: 'binary'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(res.headers['content-type'], "image/png");

              // Check Cache-Control
              var cc = res.headers['cache-control'];
              assert.equal(cc, 'public,max-age=31536000');  // 1 year

              // Check X-Cache-Channel
              cc = res.headers['x-cache-channel'];
              assert.ok(cc); 
              var dbname = test_database;
              assert.equal(cc.substring(0, dbname.length), dbname);
              var jsonquery = cc.substring(dbname.length+1);
              var sentquery = JSON.parse(jsonquery);
              assert.equal(sentquery.q, 'SELECT CDB_QueryTables($windshaft$'
                + layergroup.layers[0].options.sql + ';'
                + layergroup.layers[1].options.sql 
                + '$windshaft$)');

              assert.imageEqualsFile(res.body, 'test/fixtures/test_table_0_0_0_multilayer1.png', IMAGE_EQUALS_TOLERANCE_PERCENT,
                function(err, similarity) {
                  next(err);
              });
          });
        },
        // See https://github.com/CartoDB/Windshaft-cartodb/issues/170
        function do_get_tile_nosignature(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/localhost@' + expected_token + ':cb0/0/0/0.png',
              method: 'GET',
              headers: {host: 'localhost' },
              encoding: 'binary'
          }, {}, function(res) {
              assert.equal(res.statusCode, 403, res.statusCode + ':' + res.body);
              var parsed = JSON.parse(res.body);
              var msg = parsed.error; // TODO: should it be "errors" ?
              assert.ok(msg.match(/permission denied/i), msg);
              next(err);
          });
        },
        function do_get_grid_layer0(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token
                 + '/0/0/0/0.grid.json',
              headers: {host: 'localhost' },
              method: 'GET'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(res.headers['content-type'], "text/javascript; charset=utf-8; charset=utf-8");
              assert.utfgridEqualsFile(res.body, 'test/fixtures/test_table_0_0_0_multilayer1.layer0.grid.json', IMAGE_EQUALS_TOLERANCE_PERCENT,
                function(err, similarity) {
                  next(err);
              });
          });
        },
        function do_get_grid_layer1(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token
                 + '/1/0/0/0.grid.json',
              headers: {host: 'localhost' },
              method: 'GET'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(res.headers['content-type'], "text/javascript; charset=utf-8; charset=utf-8");
              assert.utfgridEqualsFile(res.body, 'test/fixtures/test_table_0_0_0_multilayer1.layer1.grid.json', IMAGE_EQUALS_TOLERANCE_PERCENT,
                function(err, similarity) {
                  next(err);
              });
          });
        },
        function finish(err) {
          var errors = [];
          if ( err ) {
            errors.push(err.message);
            console.log("Error: " + err);
          }
          redis_client.keys("map_cfg|" + expected_token, function(err, matches) {
              if ( err ) errors.push(err.message);
              assert.equal(matches.length, 1, "Missing expected token " + expected_token + " from redis: " + matches);
              redis_client.del(matches, function(err) {
                if ( err ) errors.push(err.message);
                if ( errors.length ) done(new Error(errors));
                else done(null);
              });
          });
        }
      );
    });


    test("should include serverMedata in the response", function(done) {
      global.environment.serverMetadata = { cdn_url : { http:'test', https: 'tests' } }
      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: 'select cartodb_id, ST_Translate(the_geom_webmercator, 5e6, 0) as the_geom_webmercator from test_table limit 2',
               cartocss: '#layer { marker-fill:red; marker-width:32; marker-allow-overlap:true; }', 
               cartocss_version: '2.0.1'
             } }
        ]
      };

      var expected_token; 
      Step(
        function do_create_get()
        {
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup?config=' + encodeURIComponent(JSON.stringify(layergroup)),
              method: 'GET',
              headers: {host: 'localhost'} 
          }, {}, function(res, err) { next(err, res); });
        },
        function do_check_create(err, res) {
          var parsed = JSON.parse(res.body);
          assert.ok(_.isEqual(parsed.cdn_url, global.environment.serverMetadata.cdn_url));
          done();
        }
      )
    });


    test("get creation requests has cache", function(done) {

      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: 'select cartodb_id, ST_Translate(the_geom_webmercator, 5e6, 0) as the_geom_webmercator from test_table limit 2',
               cartocss: '#layer { marker-fill:red; marker-width:32; marker-allow-overlap:true; }', 
               cartocss_version: '2.0.1'
             } }
        ]
      };

      var expected_token; 
      Step(
        function do_create_get()
        {
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup?config=' + encodeURIComponent(JSON.stringify(layergroup)),
              method: 'GET',
              headers: {host: 'localhost'} 
          }, {}, function(res, err) { next(err, res); });
        },
        function do_check_create(err, res) {
          if ( err ) throw err;
          assert.equal(res.statusCode, 200, res.body);
          var parsedBody = JSON.parse(res.body);
          expected_token = parsedBody.layergroupid.split(':')[0];
          helper.checkCache(res);
          return null;
        },
        function finish(err) {
          var errors = [];
          if ( err ) {
            errors.push(err.message);
            console.log("Error: " + err);
          }
          redis_client.keys("map_cfg|" + expected_token, function(err, matches) {
              if ( err ) errors.push(err.message);
              assert.equal(matches.length, 1, "Missing expected token " + expected_token + " from redis: " + matches);
              redis_client.del(matches, function(err) {
                if ( err ) errors.push(err.message);
                if ( errors.length ) done(new Error(errors));
                else done(null);
              });
          });
        }
      );
    });

    test("get creation has no cache if sql is bogus", function(done) {
        var layergroup =  {
            version: '1.0.0',
            layers: [
                { options: {
                    sql: 'select bogus(0,0) as the_geom_webmercator',
                    cartocss: '#layer { polygon-fill: red; }',
                    cartocss_version: '2.0.1'
                } }
            ]
        };
        assert.response(server, {
            url: '/tiles/layergroup?config=' + encodeURIComponent(JSON.stringify(layergroup)),
            method: 'GET',
            headers: {host: 'localhost'}
        }, {}, function(res) {
            assert.notEqual(res.statusCode, 200);
            helper.checkNoCache(res);
            done();
        });
    });

    test("get creation has no cache if cartocss is not valid", function(done) {
        var layergroup =  {
            version: '1.0.0',
            layers: [
                { options: {
                    sql: 'select cartodb_id, ST_Translate(the_geom_webmercator, 5e6, 0) as the_geom_webmercator from test_table limit 2',
                    cartocss: '#layer { invalid-rule:red; }',
                    cartocss_version: '2.0.1'
                } }
            ]
        };
        assert.response(server, {
            url: '/tiles/layergroup?config=' + encodeURIComponent(JSON.stringify(layergroup)),
            method: 'GET',
            headers: {host: 'localhost'}
        }, {}, function(res) {
            assert.notEqual(res.statusCode, 200);
            helper.checkNoCache(res);
            done();
        });
    });

    test("layergroup can hold substitution tokens", function(done) {

      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: 'select 1 as cartodb_id, '
                  + 'ST_Buffer(!bbox!, -32*greatest(!pixel_width!,!pixel_height!)) as the_geom_webmercator',
               cartocss: '#layer { polygon-fill:red; }', 
               cartocss_version: '2.0.1',
               interactivity: 'cartodb_id'
             } }
        ]
      };

      var expected_token; //  = "6d8e4ad5458e2d25cf0eef38e38717a6";
      Step(
        function do_post()
        {
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: JSON.stringify(layergroup)
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              var parsedBody = JSON.parse(res.body);
              var expectedBody = { layergroupid: expected_token };
              // check last modified
              var qTables = JSON.stringify({
                'q': 'SELECT CDB_QueryTables($windshaft$'
                    + layergroup.layers[0].options.sql
                    + '$windshaft$)'
              });
              assert.equal(parsedBody.last_updated, expected_last_updated);
              if ( expected_token ) {
                assert.equal(parsedBody.layergroupid, expected_token + ':' + expected_last_updated_epoch);
              }
              else expected_token = parsedBody.layergroupid.split(':')[0];
              next(null, res);
          });
        },
        function do_get_tile1(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token + ':cb10/1/0/0.png',
              method: 'GET',
              headers: {host: 'localhost' },
              encoding: 'binary'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(res.headers['content-type'], "image/png");

              // Check X-Cache-Channel
              var cc = res.headers['x-cache-channel'];
              assert.ok(cc); 
              var dbname = test_database;
              assert.equal(cc.substring(0, dbname.length), dbname);
              var jsonquery = cc.substring(dbname.length+1);
              var sentquery = JSON.parse(jsonquery);
              assert.equal(sentquery.q, 'SELECT CDB_QueryTables($windshaft$'
                + layergroup.layers[0].options.sql
                    .replace(RegExp('!bbox!', 'g'), 'ST_MakeEnvelope(0,0,0,0)')
                    .replace(RegExp('!pixel_width!', 'g'), '1')
                    .replace(RegExp('!pixel_height!', 'g'), '1')
                + '$windshaft$)');

              assert.imageEqualsFile(res.body, 'test/fixtures/test_multilayer_bbox.png', IMAGE_EQUALS_TOLERANCE_PERCENT,
                function(err, similarity) {
                  next(err);
              });
          });
        },
        function do_get_tile4(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token + ':cb11/4/0/0.png',
              method: 'GET',
              headers: {host: 'localhost' },
              encoding: 'binary'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(res.headers['content-type'], "image/png");

              // Check X-Cache-Channel
              var cc = res.headers['x-cache-channel'];
              assert.ok(cc); 
              var dbname = test_database;
              assert.equal(cc.substring(0, dbname.length), dbname);
              var jsonquery = cc.substring(dbname.length+1);
              var sentquery = JSON.parse(jsonquery);
              assert.equal(sentquery.q, 'SELECT CDB_QueryTables($windshaft$'
                + layergroup.layers[0].options.sql
                    .replace('!bbox!', 'ST_MakeEnvelope(0,0,0,0)')
                    .replace('!pixel_width!', '1')
                    .replace('!pixel_height!', '1')
                + '$windshaft$)');

              assert.imageEqualsFile(res.body, 'test/fixtures/test_multilayer_bbox.png', IMAGE_EQUALS_TOLERANCE_PERCENT,
                function(err, similarity) {
                  next(err);
              });
          });
        },
        function do_get_grid1(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token
                 + '/0/1/0/0.grid.json',
              headers: {host: 'localhost' },
              method: 'GET'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(res.headers['content-type'], "text/javascript; charset=utf-8; charset=utf-8");
              assert.utfgridEqualsFile(res.body, 'test/fixtures/test_multilayer_bbox.grid.json', IMAGE_EQUALS_TOLERANCE_PERCENT,
                function(err, similarity) {
                  next(err);
              });
          });
        },
        function do_get_grid4(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token
                 + '/0/4/0/0.grid.json',
              headers: {host: 'localhost' },
              method: 'GET'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(res.headers['content-type'], "text/javascript; charset=utf-8; charset=utf-8");
              assert.utfgridEqualsFile(res.body, 'test/fixtures/test_multilayer_bbox.grid.json', IMAGE_EQUALS_TOLERANCE_PERCENT,
                function(err, similarity) {
                  next(err);
              });
          });
        },
        function finish(err) {
          var errors = [];
          if ( err ) {
            errors.push(err.message);
            console.log("Error: " + err);
          }
          redis_client.keys("map_cfg|" + expected_token, function(err, matches) {
              if ( err ) errors.push(err.message);
              assert.equal(matches.length, 1, "Missing expected token " + expected_token + " from redis: " + matches);
              redis_client.del(matches, function(err) {
                if ( err ) errors.push(err.message);
                if ( errors.length ) done(new Error(errors));
                else done(null);
              });
          });
        }
      );
    });

    test("layergroup creation raises mapviews counter", function(done) {
      var layergroup =  {
        stat_tag: 'random_tag',
        version: '1.0.0',
        layers: [
           { options: {
               sql: 'select 1 as cartodb_id, !pixel_height! as h, '
                  + 'ST_Buffer(!bbox!, -32*greatest(!pixel_width!,!pixel_height!)) as the_geom_webmercator',
               cartocss: '#layer { polygon-fill:red; }', 
               cartocss_version: '2.0.1' 
             } }
        ]
      };
      var statskey = "user:localhost:mapviews";
      var redis_stats_client = redis.createClient(global.environment.redis.port);
      var expected_token; // will be set on first post and checked on second
      var now = strftime("%Y%m%d", new Date());
      var errors = [];
      Step(
        function clean_stats()
        {
          var next = this;
          redis_stats_client.select(redis_stats_db, function(err) {
            if ( err ) next(err);
            else redis_stats_client.del(statskey+':global', next);
          });
        },
        function do_post_1(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: JSON.stringify(layergroup)
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              expected_token = JSON.parse(res.body).layergroupid;
              redis_stats_client.zscore(statskey + ":global", now, next);
          });
        },
        function check_global_stats_1(err, val) {
          if ( err ) throw err;
          assert.equal(val, 1, "Expected score of " + now + " in "
              +  statskey + ":global to be 1, got " + val);
          redis_stats_client.zscore(statskey+':stat_tag:random_tag', now, this);
        },
        function check_tag_stats_1_do_post_2(err, val) {
          if ( err ) throw err;
          assert.equal(val, 1, "Expected score of " + now + " in "
              +  statskey + ":stat_tag:" + layergroup.stat_tag + " to be 1, got " + val);
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: JSON.stringify(layergroup)
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(JSON.parse(res.body).layergroupid, expected_token);
              redis_stats_client.zscore(statskey+':global', now, next);
          });
        },
        function check_global_stats_2(err, val)
        {
          if ( err ) throw err;
          assert.equal(val, 2, "Expected score of " + now + " in "
              +  statskey + ":global to be 2, got " + val);
          redis_stats_client.zscore(statskey+':stat_tag:' + layergroup.stat_tag, now, this);
        },
        function check_tag_stats_2(err, val)
        {
          if ( err ) throw err;
          assert.equal(val, 2, "Expected score of " + now + " in "
              +  statskey + ":stat_tag:" + layergroup.stat_tag + " to be 2, got " + val);
          return 1;
        },
        function cleanup_map_style(err) {
          if ( err ) errors.push('' + err);
          var next = this;
          // trip epoch
          expected_token = expected_token.split(':')[0];
          redis_client.keys("map_cfg|" + expected_token, function(err, matches) {
              redis_client.del(matches, next);
          });
        },
        function cleanup_stats(err) {
          if ( err ) errors.push('' + err);
          redis_client.del([statskey+':global', statskey+':stat_tag:'+layergroup.stat_tag], this);
        },
        function finish(err) {
          if ( err ) errors.push('' + err);
          if ( errors.length ) done(new Error(errors.join(',')));
          else done(null);
        }
      );
    });

    test("layergroup creation fails if CartoCSS is bogus", function(done) {
      var layergroup =  {
        stat_tag: 'random_tag',
        version: '1.0.0',
        layers: [
           { options: {
               sql: 'select 1 as cartodb_id, !pixel_height! as h'
                  + 'ST_Buffer(!bbox!, -32*greatest(!pixel_width!,!pixel_height!)) as the_geom_webmercator',
               cartocss: '#layer { polygon-fit:red; }', 
               cartocss_version: '2.0.1' 
             } }
        ]
      };
      assert.response(server, {
          url: '/tiles/layergroup',
          method: 'POST',
          headers: {host: 'localhost', 'Content-Type': 'application/json' },
          data: JSON.stringify(layergroup)
      }, {}, function(res) {
          assert.equal(res.statusCode, 400, res.body);
          var parsed = JSON.parse(res.body);
          assert.ok(parsed.errors[0].match(/^style0/));
          assert.ok(parsed.errors[0].match(/Unrecognized rule: polygon-fit/));
          done();
      });
    });

    // Also tests that server doesn't crash:
    // see http://github.com/CartoDB/Windshaft-cartodb/issues/109
    test("layergroup creation fails if sql is bogus", function(done) {
      var layergroup =  {
        stat_tag: 'random_tag',
        version: '1.0.0',
        layers: [
           { options: {
               sql: 'select bogus(0,0) as the_geom_webmercator',
               cartocss: '#layer { polygon-fill:red; }', 
               cartocss_version: '2.0.1' 
             } }
        ]
      };
      assert.response(server, {
          url: '/tiles/layergroup',
          method: 'POST',
          headers: {host: 'localhost', 'Content-Type': 'application/json' },
          data: JSON.stringify(layergroup)
      }, {}, function(res) {
          assert.equal(res.statusCode, 404, res.statusCode + ": " + res.body);
          var parsed = JSON.parse(res.body);
          var msg = parsed.errors[0];
          assert.ok(msg.match(/bogus.*exist/), msg);
          helper.checkNoCache(res);
          done();
      });
    });

    test("layergroup with 2 private-table layers", function(done) {

      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: 'select * from test_table_private_1 where cartodb_id=1',
               cartocss: '#layer { marker-fill:red; marker-width:32; marker-allow-overlap:true; }', 
               cartocss_version: '2.1.0',
               interactivity: 'cartodb_id'
             } },
           { options: {
               sql: 'select * from test_table_private_1 where cartodb_id=2',
               cartocss: '#layer { marker-fill:blue; marker-allow-overlap:true; }', 
               cartocss_version: '2.1.0',
               interactivity: 'cartodb_id'
             } }
        ]
      };

      var expected_token; // = "b4ed64d93a411a59f330ab3d798e4009";
      Step(
        function do_post()
        {
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup?map_key=1234',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: JSON.stringify(layergroup)
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              var parsedBody = JSON.parse(res.body);
              var expectedBody = { layergroupid: expected_token };
              // check last modified
              var qTables = JSON.stringify({
                'q': 'SELECT CDB_QueryTables($windshaft$'
                    + layergroup.layers[0].options.sql + ';'
                    + layergroup.layers[1].options.sql 
                    + '$windshaft$)'
              });
              assert.equal(parsedBody.last_updated, expected_last_updated);
              if ( expected_token ) {
                assert.equal(parsedBody.layergroupid, expected_token + ':' + expected_last_updated_epoch);
              }
              else expected_token = parsedBody.layergroupid.split(':')[0];
              next(null, res);
          });
        },
        function do_get_tile(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token + ':cb0/0/0/0.png?map_key=1234',
              method: 'GET',
              headers: {host: 'localhost' },
              encoding: 'binary'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(res.headers['content-type'], "image/png");

              // Check X-Cache-Channel
              var cc = res.headers['x-cache-channel'];
              assert.ok(cc); 
              var dbname = test_database;
              assert.equal(cc.substring(0, dbname.length), dbname);
              next(err);
          });
        },
        function do_get_grid_layer0(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token
                 + '/0/0/0/0.grid.json?map_key=1234',
              headers: {host: 'localhost' },
              method: 'GET'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              next(err);
          });
        },
        function do_get_grid_layer1(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token
                 + '/1/0/0/0.grid.json?map_key=1234',
              headers: {host: 'localhost' },
              method: 'GET'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(res.headers['content-type'], "text/javascript; charset=utf-8; charset=utf-8");
              next(err);
          });
        },
        function do_get_tile_unauth(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token + ':cb0/0/0/0.png',
              method: 'GET',
              headers: {host: 'localhost' },
              encoding: 'binary'
          }, {}, function(res) {
              assert.equal(res.statusCode, 403);
              var re = RegExp('permission denied');
              assert.ok(res.body.match(re), 'No "permission denied" error: ' + res.body);
              next(err);
          });
        },
        function do_get_grid_layer0_unauth(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token
                 + '/0/0/0/0.grid.json',
              headers: {host: 'localhost' },
              method: 'GET'
          }, {}, function(res) {
              assert.equal(res.statusCode, 403);
              var re = RegExp('permission denied');
              assert.ok(res.body.match(re), 'No "permission denied" error: ' + res.body);
              next(err);
          });
        },
        function do_get_grid_layer1_unauth(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token
                 + '/1/0/0/0.grid.json',
              headers: {host: 'localhost' },
              method: 'GET'
          }, {}, function(res) {
              assert.equal(res.statusCode, 403);
              var re = RegExp('permission denied');
              assert.ok(res.body.match(re), 'No "permission denied" error: ' + res.body);
              next(err);
          });
        },
        function finish(err) {
          var errors = [];
          if ( err ) {
            errors.push(err.message);
            console.log("Error: " + err);
          }
          redis_client.keys("map_cfg|" + expected_token, function(err, matches) {
              if ( err ) errors.push(err.message);
              assert.equal(matches.length, 1, "Missing expected token " + expected_token + " from redis: " + matches);
              redis_client.del(matches, function(err) {
                if ( err ) errors.push(err.message);
                if ( errors.length ) done(new Error(errors));
                else done(null);
              });
          });
        }
      );
    });

    // See https://github.com/CartoDB/Windshaft-cartodb/issues/152
    test("x-cache-channel still works for GETs after tiler restart", function(done) {

      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: 'select * from test_table where cartodb_id=1',
               cartocss: '#layer { marker-fill:red; marker-width:32; marker-allow-overlap:true; }', 
               cartocss_version: '2.1.0',
               interactivity: 'cartodb_id'
             } }
        ]
      };

      var expected_token; // = "b4ed64d93a411a59f330ab3d798e4009";
      Step(
        function do_post()
        {
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup?map_key=1234',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: JSON.stringify(layergroup)
          }, {}, function(res, err) { next(err, res); });
        },
        function check_post(err, res) {
          if ( err ) throw err;
          assert.equal(res.statusCode, 200, res.body);
          var parsedBody = JSON.parse(res.body);
          var expectedBody = { layergroupid: expected_token };
          // check last modified
          var qTables = JSON.stringify({
            'q': 'SELECT CDB_QueryTables($windshaft$'
                + layergroup.layers[0].options.sql
                + '$windshaft$)'
          });
          assert.equal(parsedBody.last_updated, expected_last_updated);
          if ( expected_token ) {
            assert.equal(parsedBody.layergroupid, expected_token + ':' + expected_last_updated_epoch);
          }
          else expected_token = parsedBody.layergroupid.split(':')[0];
          return null;
        },
        function do_get0(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token + ':cb0/0/0/0.png?map_key=1234',
              method: 'GET',
              headers: {host: 'localhost' },
              encoding: 'binary'
          }, {}, function(res, err) { next(err, res); });
        },
        function do_check0(err, res) {
          if ( err ) throw err;
          assert.equal(res.statusCode, 200, res.body);
          assert.equal(res.headers['content-type'], "image/png");

          // Check X-Cache-Channel
          var cc = res.headers['x-cache-channel'];
          assert.ok(cc, "Missing X-Cache-Channel"); 
          var dbname = test_database;
          assert.equal(cc.substring(0, dbname.length), dbname);
          return null;
        },
        function do_restart_server(err, res) {
          if ( err ) throw err;
          // hack simulating restart...
          serverOptions = ServerOptions();
          server = new CartodbWindshaft(serverOptions);
          return null;
        },
        function do_get1(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token + ':cb0/0/0/0.png?map_key=1234',
              method: 'GET',
              headers: {host: 'localhost' },
              encoding: 'binary'
          }, {}, function(res, err) { next(err, res); });
        },
        function do_check1(err, res) {
          if ( err ) throw err;
          assert.equal(res.statusCode, 200, res.body);
          assert.equal(res.headers['content-type'], "image/png");

          // Check X-Cache-Channel
          var cc = res.headers['x-cache-channel'];
          assert.ok(cc, "Missing X-Cache-Channel on restart");
          var dbname = test_database;
          assert.equal(cc.substring(0, dbname.length), dbname);
          return null;
        },
        function finish(err) {
          var errors = [];
          if ( err ) {
            errors.push(err.message);
            console.log("Error: " + err);
          }
          redis_client.keys("map_cfg|" + expected_token, function(err, matches) {
              if ( err ) errors.push(err.message);
              assert.equal(matches.length, 1, "Missing expected token " + expected_token + " from redis: " + matches);
              redis_client.del(matches, function(err) {
                if ( err ) errors.push(err.message);
                if ( errors.length ) done(new Error(errors.join(',')));
                else done(null);
              });
          });
        }
      );
    });

    // https://github.com/cartodb/Windshaft-cartodb/issues/81
    test("invalid text-name in CartoCSS", function(done) {

      var layergroup =  {
        version: '1.0.1',
        layers: [
           { options: {
               sql: "select 1 as cartodb_id, 'SRID=3857;POINT(0 0)'::geometry as the_geom_webmercator",
               cartocss: '#sample { text-name: cartodb_id; text-face-name: "Dejagnu"; }',
               cartocss_version: '2.1.0',
             } }
        ]
      };

      assert.response(server, {
          url: '/tiles/layergroup?',
          method: 'POST',
          headers: {host: 'localhost', 'Content-Type': 'application/json' },
          data: JSON.stringify(layergroup)
      }, {}, function(res) {
          assert.equal(res.statusCode, 400, res.statusCode + ': ' + res.body);
          var parsed = JSON.parse(res.body);
          assert.equal(parsed.errors.length, 1);
          var errmsg = parsed.errors[0];
          assert.ok(errmsg.match(/text-face-name.*Dejagnu/), parsed.errors.toString());
          done();
      });
    });

    test("quotes CartoCSS", function(done) {

      var layergroup =  {
        version: '1.0.1',
        layers: [
           { options: {
               sql: "select 'single''quote' as n, 'SRID=3857;POINT(0 0)'::geometry as the_geom_webmercator",
               cartocss: '#s [n="single\'quote" ] { marker-fill:red; }',
               cartocss_version: '2.1.0',
             } },
           { options: {
               sql: "select 'double\"quote' as n, 'SRID=3857;POINT(2 0)'::geometry as the_geom_webmercator",
               cartocss: '#s [n="double\\"quote" ] { marker-fill:red; }',
               cartocss_version: '2.1.0',
             } }
        ]
      };

      assert.response(server, {
          url: '/tiles/layergroup?',
          method: 'POST',
          headers: {host: 'localhost', 'Content-Type': 'application/json' },
          data: JSON.stringify(layergroup)
      }, {}, function(res) {
          assert.equal(res.statusCode, 200, res.statusCode + ': ' + res.body);
          done();
      });
    });

    // See https://github.com/CartoDB/Windshaft-cartodb/issues/87
    test("exponential notation in CartoCSS filter values", function(done) {
      var layergroup =  {
        version: '1.0.1',
        layers: [
           { options: {
               sql: "select .4 as n, 'SRID=3857;POINT(0 0)'::geometry as the_geom_webmercator",
               cartocss: '#s [n<=.2e-2] { marker-fill:red; }',
               cartocss_version: '2.1.0',
             } }
        ]
      };
      assert.response(server, {
          url: '/tiles/layergroup?',
          method: 'POST',
          headers: {host: 'localhost', 'Content-Type': 'application/json' },
          data: JSON.stringify(layergroup)
      }, {}, function(res) {
          assert.equal(res.statusCode, 200, res.statusCode + ': ' + res.body);
          done();
      });
    });

    // See https://github.com/CartoDB/Windshaft-cartodb/issues/93
    test("accepts unused directives", function(done) {
      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: "select 'SRID=3857;POINT(0 0)'::geometry as the_geom_webmercator",
               cartocss: '#layer { point-transform:"scale(20)"; }', 
               cartocss_version: '2.0.1'
             } }
        ]
      };
      var expected_token; // = "e34dd7e235138a062f8ba7ad051aa3a7";
      Step(
        function do_post()
        {
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: JSON.stringify(layergroup)
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              var parsedBody = JSON.parse(res.body);
              var expectedBody = { layergroupid: expected_token };
              if ( expected_token ) {
                assert.equal(parsedBody.layergroupid, expected_token + ':' + expected_last_updated_epoch);
              }
              else {
                var token_components = parsedBody.layergroupid.split(':');
                expected_token = token_components[0];
                expected_last_updated_epoch = token_components[1];
              }
              next(null, res);
          });
        },
        function do_get_tile(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token + ':cb0/0/0/0.png',
              method: 'GET',
              headers: {host: 'localhost' },
              encoding: 'binary'
          }, {}, function(res) {
              assert.equal(res.statusCode, 200, res.body);
              assert.equal(res.headers['content-type'], "image/png");
              assert.imageEqualsFile(res.body, windshaft_fixtures + '/test_default_mapnik_point.png', IMAGE_EQUALS_TOLERANCE_PERCENT,
                function(err, similarity) {
                  next(err);
              });
          });
        },
        function finish(err) {
          var errors = [];
          if ( err ) {
            errors.push(err.message);
            console.log("Error: " + err);
          }
          redis_client.keys("map_cfg|" + expected_token, function(err, matches) {
              if ( err ) errors.push(err.message);
              assert.equal(matches.length, 1, "Missing expected token " + expected_token + " from redis: " + matches);
              redis_client.del(matches, function(err) {
                if ( err ) errors.push(err.message);
                if ( errors.length ) done(new Error(errors));
                else done(null);
              });
          });
        }
      );
    });

    // See https://github.com/CartoDB/Windshaft-cartodb/issues/91
    // and https://github.com/CartoDB/Windshaft-cartodb/issues/38
    test("tiles for private tables can be fetched with api_key", function(done) {
      var errors = [];
      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: "select * from test_table_private_1 LIMIT 0",
               cartocss: '#layer { marker-fill:red; }', 
               cartocss_version: '2.0.1'
             } }
        ]
      };
      var expected_token; // = "e34dd7e235138a062f8ba7ad051aa3a7";
      Step(
        function do_post()
        {
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup?api_key=1234',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: JSON.stringify(layergroup)
          }, {}, function(res) { next(null, res); });
        },
        function check_result(err, res) {
          if ( err ) throw err;
          var next = this;
          assert.equal(res.statusCode, 200, res.statusCode + ': ' + res.body);
          var parsedBody = JSON.parse(res.body);
          if ( expected_token ) {
            assert.equal(parsedBody.layergroupid, expected_token + ':' + expected_last_updated_epoch);
          }
          else {
            var token_components = parsedBody.layergroupid.split(':');
            expected_token = token_components[0];
            expected_last_updated_epoch = token_components[1];
          }
          next(null, res);
        },
        function do_get_tile(err)
        {
          if ( err ) throw err;
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup/' + expected_token + ':cb0/0/0/0.png?api_key=1234',
              method: 'GET',
              headers: {host: 'localhost' },
              encoding: 'binary'
          }, {}, function(res) { next(null, res); });
        },
        function check_get_tile(err, res) {
          if ( err ) throw err;
          var next = this;
          assert.equal(res.statusCode, 200, res.body);
          return null;
        },
        function cleanup(err) {
          if ( err ) errors.push(err.message);
          if ( ! expected_token ) return null;
          var next = this;
          redis_client.keys("map_cfg|" + expected_token, function(err, matches) {
              if ( err ) errors.push(err.message);
              assert.equal(matches.length, 1, "Missing expected token " + expected_token + " from redis: " + matches);
              redis_client.del(matches, function(err) {
                if ( err ) errors.push(err.message);
                next();
              });
          });
        },
        function finish(err) {
          if ( err ) {
            errors.push(err.message);
            console.log("Error: " + err);
          }
          if ( errors.length ) done(new Error(errors));
          else done(null);
        }
      );
    });

    // SQL strings can be of arbitrary length, when using POST
    // See https://github.com/CartoDB/Windshaft-cartodb/issues/111
    test("sql string can be very long", function(done){
      var long_val = 'pretty';
      for (var i=0; i<1024; ++i) long_val += ' long'
      long_val += ' string';
      var sql = "SELECT ";
      for (var i=0; i<16; ++i) 
        sql += "'" + long_val + "'::text as pretty_long_field_name_" + i + ", ";
      sql += "cartodb_id, the_geom_webmercator FROM gadm4 g";
      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: sql,
               cartocss: '#layer { marker-fill:red; }', 
               cartocss_version: '2.0.1'
             } }
        ]
      };
      var errors = [];
      var expected_token; 
      Step(
        function do_post()
        {
          var data = JSON.stringify(layergroup);
          assert.ok(data.length > 1024*64);
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup?api_key=1234',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: data
          }, {}, function(res) { next(null, res); });
        },
        function check_result(err, res) {
          if ( err ) throw err;
          assert.equal(res.statusCode, 200, res.statusCode + ': ' + res.body);
          var parsedBody = JSON.parse(res.body);
          var token_components = parsedBody.layergroupid.split(':');
          expected_token = token_components[0];
          var last_request = sqlapi_server.getLastRequest();
          assert.equal(last_request.method, 'POST');
          return null;
        },
        function cleanup(err) {
          if ( err ) errors.push('' + err);
          if ( ! expected_token ) return null;
          var next = this;
          redis_client.keys("map_cfg|" + expected_token, function(err, matches) {
              if ( err ) errors.push(err.message);
              assert.equal(matches.length, 1, "Missing expected token " + expected_token + " from redis: " + matches);
              redis_client.del(matches, function(err) {
                if ( err ) errors.push(err.message);
                next();
              });
          });
        },
        function finish(err) {
          if ( err ) errors.push('' + err);
          if ( errors.length ) done(new Error(errors.join(',')));
          else done(null);
        }
      );
    });

    // See https://github.com/CartoDB/Windshaft-cartodb/issues/133
    test("MapConfig with mapnik layer and no cartocss", function(done) {

      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: 'select cartodb_id, ST_Translate(the_geom_webmercator, 5e6, 0) as the_geom_webmercator from test_table limit 2',
               interactivity: 'cartodb_id'
             } }
        ]
      };

      Step(
        function do_post()
        {
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: JSON.stringify(layergroup)
          }, {}, function(res, err) { next(err, res); });
        },
        function check_post(err, res) {
          if ( err ) throw err;
          assert.equal(res.statusCode, 400, res.statusCode + ': ' + res.body);
          var parsed = JSON.parse(res.body);
          assert.ok(parsed.errors, 'Missing "errors" in response: ' + JSON.stringify(parsed));
          assert.equal(parsed.errors.length, 1);
          var msg = parsed.errors[0];
          assert.equal(msg, 'Missing cartocss for layer 0 options');
          return null;
        },
        function finish(err) {
          done(err);
        }
      );
    });

    // See https://github.com/CartoDB/Windshaft-cartodb/issues/167
    test("lack of response from sql-api will result in a timeout", function(done) {

      var layergroup =  {
        version: '1.0.0',
        layers: [
           { options: {
               sql: "select *, 'SQLAPINOANSWER' from test_table",
               cartocss: '#layer { marker-fill:red; marker-width:32; marker-allow-overlap:true; }', 
               cartocss_version: '2.1.0'
             } }
        ]
      };

      Step(
        function do_post()
        {
          var next = this;
          assert.response(server, {
              url: '/tiles/layergroup',
              method: 'POST',
              headers: {host: 'localhost', 'Content-Type': 'application/json' },
              data: JSON.stringify(layergroup)
          }, {}, function(res, err) { next(err, res); });
        },
        function check_post(err, res) {
          if ( err ) throw err;
          assert.equal(res.statusCode, 400, res.statusCode + ': ' + res.body);
          var parsed = JSON.parse(res.body);
          assert.ok(parsed.errors, 'Missing "errors" in response: ' + JSON.stringify(parsed));
          assert.equal(parsed.errors.length, 1);
          var msg = parsed.errors[0];
          assert.ok(msg, /could not fetch source tables/, msg);
          return null;
        },
        function finish(err) {
          done(err);
        }
      );
    });


    suiteTeardown(function(done) {

        // This test will add map_style records, like
        // 'map_style|null|publicuser|my_table',
        redis_client.keys("map_style|*", function(err, matches) {
            redis_client.del(matches, function(err) {
              redis_client.select(5, function(err, matches) {
                redis_client.keys("user:localhost:mapviews*", function(err, matches) {
                  redis_client.del(matches, function(err) {
                    sqlapi_server.close(done);
                  });
                });
              });
            });
        });

    });
    
});

