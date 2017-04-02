var mongoose = require('mongoose');
var BaseModel = require("./base_model");
var Schema = mongoose.Schema;
var ObjectId = Schema.ObjectId;
var config = require('../config');
var _ = require('lodash');

var ActivitySchema = new Schema({
  title: { type: String },
  content: { type: String },
  summary: { type: String },
  begin_time: { type: Date },
  end_time: { type: Date },
  location: { type: String },
  status: {type: Number, default: 1 }, //1-活动未开始; 2-活动进行中; 3-活动已结束
  pic: { type: Array },
  type: { type: String }, //活动类型
  author_id: { type: ObjectId },
  top: { type: Boolean, default: false }, // 置顶帖
  good: { type: Boolean, default: false }, // 精华帖
  reply_count: { type: Number, default: 0 },
  visit_count: { type: Number, default: 0 },
  collect_count: { type: Number, default: 0 },
  create_at: { type: Date, default: Date.now },
  update_at: { type: Date, default: Date.now },
  last_reply: { type: ObjectId },
  last_reply_at: { type: Date, default: Date.now },
  content_is_html: { type: Boolean },
  reprint: { type: String, default: '' },
  lock: {type: Boolean, default: false}, // 被锁定主题
  deleted: {type: Boolean, default: false},
});

ActivitySchema.plugin(BaseModel);
ActivitySchema.index({ create_at: -1 });
ActivitySchema.index({ top: -1, last_reply_at: -1 });
ActivitySchema.index({ author_id: 1, create_at: -1 });

ActivitySchema.virtual('tabName').get(function () {
  var tab = this.tab;
  var pair = _.find(config.tabs, function (_pair) {
    return _pair[0] === tab;
  });

  if (pair) {
    return pair[1];
  } else {
    return '';
  }
});

mongoose.model('Activity', ActivitySchema);
