var validator = require('validator');
var at = require('../common/at');
var User = require('../proxy').User;
var Question = require('../proxy').Question;
var Reply = require('../proxy').Reply;
var QuestionAnswer = require('../proxy').QuestionAnswer;
var UserCollect = require('../proxy').UserCollect;
var EventProxy = require('eventproxy');
var tools = require('../common/tools');
var store = require('../common/store');
var config = require('../config');
var _ = require('lodash');
var cache = require('../common/cache');
var logger = require('../common/logger');
var escapeHtml = require('escape-html');
var mail = require('../common/mail');
var dataAdapter = require('../common/dataAdapter');
var renderHelper = require('../common/render_helper');

function saveQuestion(req, next, callback) {
  var title = escapeHtml(validator.trim(req.body.title));
  var tab = validator.escape(validator.trim(req.body.tab));
  var content = validator.trim(req.body.content || req.body.t_content);

  var user = req.session.user;
  var ep = new EventProxy();
  ep.fail(next);

  // console.log(title+"is done !");

  Question.newAndSave(title, tab, content, user._id, ep.done('question'));

  ep.all('question', function (question, user) {
    callback(null, question);
  });
};

/**
 * Question page
 *
 * @param  {HttpRequest} req
 * @param  {HttpResponse} res
 * @param  {Function} next
 */
exports.index = function (req, res, next) {
  function isUped(user, reply) {
    if (!reply.ups) {
      return false;
    }
    return reply.ups.indexOf(user._id) !== -1;
  }

  var question_id = req.params.qid;
  var currentUser = req.session.user;

  if (question_id.length !== 24) {
    return res.render404('此话题不存在或已被删除。');
  }
  var events = ['question', 'tops', 'is_collect', 'answer'];
  var ep = EventProxy.create(events,
    function (question, tops, is_collect, answer) {
      res.render('question/index', {
        active: 'question',
        question: dataAdapter.outQuestion(question),
        answer: dataAdapter.outReply(answer),
        tops: tops,
        is_uped: isUped,
        is_collect: is_collect,
        tabs: config.tabs
      });
    });

  ep.fail(next);

  // 取排行榜上的用户
  cache.get('tops', ep.done(function (tops) {
    if (tops) {
      ep.emit('tops', tops);
    } else {
      User.getUsersByQuery(
        { is_block: false },
        { limit: 10, sort: '-score' },
        ep.done('tops', function (tops) {
          cache.set('tops', tops, 60 * 1);
          return tops;
        })
      );
    }
  }));
  // END 取排行榜上的用户

  Question.getFullQuestion(question_id, ep.done(function (message, question, author, replies) {
    if (message) {
      logger.error('getFullQuestion error question_id: ' + question_id)
      return res.renderError(message);
    }

    question.visit_count += 1;
    question.save();

    question.author = author;
    var mainReplies = dataAdapter.appendSubRepliesToReplies(replies);
    question.replies = dataAdapter.outReplies(mainReplies);

    // 点赞数排名第三的回答，它的点赞数就是阈值
    question.reply_up_threshold = (function () {
      var allUpCount = replies.map(function (reply) {
        return reply.ups && reply.ups.length || 0;
      });
      allUpCount = _.sortBy(allUpCount, Number).reverse();

      var threshold = allUpCount[2] || 0;
      if (threshold < 3) {
        threshold = 3;
      }
      return threshold;
    })();

    ep.emit('question', question);
  }));

  if (!currentUser) {
    ep.emit('is_collect', null);
  } else {
    UserCollect.getUserCollect(currentUser._id, question_id, ep.done('is_collect'));
  }
  QuestionAnswer.getQuestionAnswer(question_id, null, ep.done(function(item) {
      if (!item) {
          return ep.emit('answer', null);
      }else{
        Reply.getReplyById(item.answer_id, ep.done(function(reply) {
            //console.log(reply);
            if (!reply) {
                return ep.emit('answer', null);
            }
            ep.emit('answer', reply);
        }));
      }
  }));
};

exports.create = function (req, res, next) {
  res.render('question/edit', {
    active: 'question',
    tabs: config.tabs
  });
};

exports.put = function (req, res, next) {
  console.log(req.body);
  //for marktang
  if (!req.body.title || !req.body.content || !req.body.tab) {
    res.render('/question/edit', {
      content_from_marktang: req.body.content || ''
    });
    return;
  }
  saveQuestion(req, next, function (err, question) {
      if (err || !question) {
        res.send({
          ret: 400
        });
      } else {
        //发送at消息
        // at.sendMessageToMentionUsers(content, question._id, req.session.user._id);
        res.redirect('/question/tab/'+question.tab);
      }
  });
}

exports.list = function (req, res, next) {
  var page = parseInt(req.query.page, 10) || 1;
  page = page > 0 ? page : 1;
  var tab = req.params.tab || 'all';
  var solved = req.query.solved || 'all';
  var sort = req.query.sort || 'hot';
  var sortMap = {
    'hot': '-visit_count -collect_count -reply_count -create_at',
    'latest': '-create_at',
    'reply': '-reply_count'
  };
  var sortType = sortMap[sort] || sortMap['default'];

  var proxy = new EventProxy();
  proxy.fail(next);
  // 取主题
  var query = {};
  if (tab && tab !== 'all') {
    query.tab = tab;
  }
  if(solved === 'true'){
    query.solved = true;
  }else if(solved === 'false'){
    query.solved = false;
  }
  var limit = config.list_question_count;
  var options = {
    skip: (page - 1) * limit,
    limit: limit,
    sort: sortType
  };
  // var optionsStr = JSON.stringify(query) + JSON.stringify(options);
  // console.log(optionsStr);
  Question.getQuestionsByQuery(query, options, proxy.done('questions', function (questions) {
    //console.log(questions);
    return questions.map(function(question){
      return dataAdapter.outQuestion(question);
    });//questionMock;
  }));

  // 取分页数据
  var pagesCacheKey = JSON.stringify(query) + 'question_pages';
  cache.get(pagesCacheKey, proxy.done(function (pages) {
    if (pages) {
      proxy.emit('pages', pages);
    } else {
      Question.getCountByQuery(query, proxy.done(function (all_questions_count) {
        var pages = Math.ceil(all_questions_count / limit);
        cache.set(pagesCacheKey, pages, 60 * 1);
        proxy.emit('pages', pages);
      }));
    }
  }));
  // END 取分页数据

  // 取排行榜上的用户
  cache.get('tops', proxy.done(function (tops) {
    if (tops) {
      proxy.emit('tops', tops);
    } else {
      User.getUsersByQuery(
        { is_block: false },
        { limit: 10, sort: '-score' },
        proxy.done('tops', function (tops) {
          // console.log(tops);
          cache.set('tops', tops, 60 * 1);
          return tops;
        })
      );
    }
  }));
  // END 取排行榜上的用户

  var tabs = [['all', '全部']].concat(config.tabs);
  var tabName = renderHelper.tabName(tab);

  proxy.all('questions', 'pages', 'tops', function (questions, pages, tops) {
      res.render('question/list', {
        active: 'question',
        questions: questions,
        current_page: page,
        list_question_count: limit,
        tops: tops,
        pages: pages,
        tabs: tabs,
        tab: tab,
        sort: sort,
        solved: solved,
        base: '/question/tab/' + tab,
        pageTitle: tabName && (tabName + '活动'),
      });
    });
}

exports.showEdit = function (req, res, next) {
  var question_id = req.params.qid;

  Question.getQuestionById(question_id, function (err, question, tags) {
    if (!question) {
      res.render404('此话题不存在或已被删除。');
      return;
    }

    if (String(question.author_id) === String(req.session.user._id) || req.session.user.is_admin) {
      res.render('question/edit', {
        active: 'question',
        action: 'edit',
        question_id: question._id,
        title: question.title,
        content: question.content,
        tab: question.tab,
        tabs: config.tabs
      });
    } else {
      res.renderError('对不起，你不能编辑此话题。', 403);
    }
  });
};

exports.update = function (req, res, next) {
    var json = req.body.json === 'true';
    var question_id = req.params.qid;
    var title = escapeHtml(validator.trim(req.body.title));
    var tab = validator.escape(validator.trim(req.body.tab));
    var content = validator.trim(req.body.content || req.body.t_content);

    var ep = new EventProxy();
    ep.fail(next);
    ep.on('done', function(question) {
        ep.unbind();
        if (json) {
            res.send({
                ret: 0,
                data: dataAdapter.outQuestion(question)
            });
        } else {
            res.redirect('/question/' + question._id);
        }
    });
    ep.on('fail', function(msg, question) {
        ep.unbind()
        question = question || {};
        if (json) {
            res.send({
                ret: 400,
                msg: msg
            });
        } else {
            return res.render('question/edit', {
                action: 'edit',
                edit_error: msg,
                question_id: question._id || '',
                content: question.content || '',
                tabs: config.tabs
            });
        }
    });
    var user = req.session.user;
    Question.getQuestionById(question_id, ep.done(function(question, tags) {
        if (!question) {
            return ep.emit('faile',  '此话题不存在或已被删除。');
        }
        if (!tools.idEqual(question.author_id, user._id) && !user.is_admin) {
            return ep.emit('faile', '无操作权限。', question);
        }
        // 得到所有的 tab, e.g. ['ask', 'share', ..]
        var allTabs = config.tabs.map(function (tPair) {
            return tPair[0];
        });
        /*if (!config.regExps.questionTitle.test(title)
            || !config.regExps.questionContent.test(content)
            || !_.contains(allTabs, tab)
        ) {
            return ep.emit('fail', 'param error', question);
        }*/
        question.title = title;
        question.content = content;
        question.pic = tools.genPicFromContent(content);
        question.summary = tools.genSummaryFromContent(content, config.question_summary_len);
        question.tab = tab;
        question.update_at = new Date();
        question.save(ep.done(function() {
            at.sendMessageToMentionUsers(content, question._id, user._id);
            ep.emit('done', question);
        }));
    }));
};

exports.delete = function (req, res, next) {
  //删除话题, 话题作者question_count减1
  //删除回复，回复作者reply_count减1
  //删除question_collect，用户collect_question_count减1

  var question_id = req.params.qid;
  var ep = tools.createJsonEventProxy(res, next);

  Question.getFullQuestion(question_id, function (err, err_msg, question, author, replies) {
    if (err) {
      return ep.emit('fail', 403, err.message);
    }
    if (!req.session.user.is_admin && !(question.author_id.equals(req.session.user._id))) {
      return ep.emit('fail', 403, '无权限');
    }
    if (!question) {
      return ep.emit('fail', 403, '此话题不存在或已被删除。');
    }
    author.score -= 5;
    author.question_count -= 1;
    author.save();

    question.deleted = true;
    question.save(function (err) {
      if (err) {
        return res.send({ success: false, message: err.message });
      }
      return ep.emit('done');
    });
  });
};

exports.answer = function (req, res, next) {
  var question_id = req.params.qid;
  var action = req.body.action;
  var reply_id = req.body.reply_id;
  var ep = tools.createJsonEventProxy(res, next);

  if(action ==='set' && !reply_id){
    return ep.emit('fail', 403, '参数不合法。');
  }
  Question.getQuestionById(question_id, function (err, question) {
    if (err) {
      return ep.emit('fail', 403, err.message);
    }
    if (!req.session.user.is_admin && !(question.author_id.equals(req.session.user._id))) {
      return ep.emit('fail', 403, '无权限');
    }
    if (!question) {
      return ep.emit('fail', 403, '此话题不存在或已被删除。');
    }
    if(action === 'set'){
      QuestionAnswer.remove(question_id, null, function(err){
        if (err) {
          return res.send({ success: false, message: err.message });
        }
        QuestionAnswer.newAndSave(question_id, reply_id, function (err) {
          if (err) {
            return res.send({ success: false, message: err.message });
          }
          question.solved = true;
          question.save();
          return ep.emit('done');
        });
      });
    } else if(action === 'clear'){
      QuestionAnswer.remove(question_id, reply_id, function (err) {
        if (err) {
          return res.send({ success: false, message: err.message });
        }
        question.solved = false;
        question.save();
        return ep.emit('done');
      });
    }else{
      return ep.emit('fail', 403, '参数不合法。');
    }
  });
};
