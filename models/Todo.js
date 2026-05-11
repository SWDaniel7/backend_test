// 할 일 항목 MongoDB 모델 등록
const mongoose = require("mongoose");
const todoSchema = require("./todoSchema");

module.exports = mongoose.model("Todo", todoSchema);
