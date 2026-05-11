// 할 일 생성 등 REST 라우트
const express = require("express");
const mongoose = require("mongoose");
const Todo = require("../models/Todo");

const router = express.Router();

// message 한 줄만 짧게 쓰려면 TODO_HIDE_ERROR_DETAILS=true (cause·errorName은 항상 포함)
const shortUserMessage = process.env.TODO_HIDE_ERROR_DETAILS === "true";

/** Atlas·네트워크 오류 시 사용자에게 덧붙일 안내 (개발 모드 응답에만) */
function atlasHint(error) {
  const name = error?.name || "";
  const msg = String(error?.message || "");
  if (name === "MongoServerError" || name === "MongoNetworkError") {
    const c = error.code;
    if (c === 8000 || c === 13 || /not authorized/i.test(msg)) {
      return " [Atlas] DB 사용자에 이 데이터베이스 readWrite 권한이 있는지, Network Access에 현재 공인 IP(또는 테스트용 0.0.0.0/0)가 허용됐는지 확인하세요.";
    }
    if (/timeout|timed out|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(msg)) {
      return " [네트워크] MONGODB_URI·VPN·방화벽을 확인하세요.";
    }
  }
  return "";
}

function sendFail(res, status, logPrefix, error, prodMessage) {
  console.error(logPrefix, error?.stack || error);
  const hint = atlasHint(error);
  const desc =
    error && typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : String(error ?? "알 수 없는 오류");
  const fullLine = `${logPrefix} ${desc}${hint}`;
  res.status(status).json({
    message: shortUserMessage ? prodMessage : fullLine,
    cause: desc,
    errorName: error?.name || error?.constructor?.name,
    ...(error?.code != null && { errorCode: error.code }),
    ...(hint && { atlasHint: hint.trim() }),
  });
}

const LIST_QUERY_MS = 25_000;

router.get("/", async (req, res) => {
  let listTimer;
  const listTimeout = new Promise((_, reject) => {
    listTimer = setTimeout(
      () =>
        reject(
          new Error(
            `할 일 목록 조회가 ${LIST_QUERY_MS}ms 안에 끝나지 않았습니다. Atlas Network Access·VPN·MONGODB_URI를 확인하세요.`
          )
        ),
      LIST_QUERY_MS
    );
  });
  try {
    const todos = await Promise.race([
      Todo.find().sort({ createdAt: -1 }).lean(),
      listTimeout,
    ]);
    clearTimeout(listTimer);
    res.json(todos);
  } catch (error) {
    clearTimeout(listTimer);
    if (error.code === 50 || error.codeName === "MaxTimeMSExpired") {
      res.status(504).json({
        message:
          "DB 조회 시간이 초과되었습니다. Atlas IP 허용 목록·네트워크·MONGODB_URI를 확인하세요.",
      });
      return;
    }
    if (
      String(error?.message || "").includes("할 일 목록 조회가") &&
      String(error?.message || "").includes("ms 안에 끝나지 않았습니다")
    ) {
      res.status(504).json({ message: error.message });
      return;
    }
    sendFail(
      res,
      500,
      "[GET /todos]",
      error,
      "할 일 목록을 불러오지 못했습니다.",
    );
  }
});

/** DB·컬렉션 이름과 간단 카운트만 확인 (Compass에서 어디를 봐야 하는지 확인용) */
router.get("/_health", async (req, res) => {
  try {
    const database = mongoose.connection.db?.databaseName;
    const collection = Todo.collection.collectionName;
    let estimatedCount = null;
    let countError = null;
    try {
      estimatedCount = await Todo.estimatedDocumentCount();
    } catch (e) {
      countError = {
        message: e.message,
        name: e.name,
        code: e.code,
      };
    }
    res.json({
      ok: !countError,
      database,
      collection,
      note:
        "Compass에서는 왼쪽에 '데이터베이스(database)' 이름 → 그 안에 '컬렉션(collection)' 이 보입니다. Mongoose 모델 Todo는 보통 컬렉션 이름이 'todos' 입니다.",
      estimatedCount,
      countError,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message,
      name: e.name,
      code: e.code,
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const { title } = req.body ?? {};
    if (typeof title !== "string") {
      res.status(400).json({
        message:
          'title 필드가 필요합니다(JSON 예: {"title":"할 일"}). Content-Type: application/json 인지 확인하세요.',
      });
      return;
    }
    const todo = await Todo.create({ title });
    res.status(201).json(todo);
  } catch (error) {
    if (error.name === "ValidationError") {
      res.status(400).json({ message: error.message });
      return;
    }
    sendFail(res, 500, "[POST /todos]", error, "할 일을 저장하지 못했습니다.");
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { title } = req.body;
    if (title === undefined) {
      res.status(400).json({ message: "title이 필요합니다." });
      return;
    }
    const todo = await Todo.findByIdAndUpdate(
      req.params.id,
      { title },
      { new: true, runValidators: true },
    );
    if (!todo) {
      res.status(404).json({ message: "할 일을 찾을 수 없습니다." });
      return;
    }
    res.json(todo);
  } catch (error) {
    if (error.name === "ValidationError") {
      res.status(400).json({ message: error.message });
      return;
    }
    if (error.name === "CastError") {
      res.status(400).json({ message: "잘못된 할 일 ID입니다." });
      return;
    }
    sendFail(res, 500, "[PATCH /todos]", error, "할 일을 수정하지 못했습니다.");
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const todo = await Todo.findByIdAndDelete(req.params.id);
    if (!todo) {
      res.status(404).json({ message: "할 일을 찾을 수 없습니다." });
      return;
    }
    res.json(todo);
  } catch (error) {
    if (error.name === "CastError") {
      res.status(400).json({ message: "잘못된 할 일 ID입니다." });
      return;
    }
    sendFail(res, 500, "[DELETE /todos]", error, "할 일을 삭제하지 못했습니다.");
  }
});

module.exports = router;
