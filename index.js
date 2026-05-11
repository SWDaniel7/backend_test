// todo-backend 기본 Node.js 실행 진입점 파일.
const fs = require("fs");
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const ENV_PATH = path.join(__dirname, ".env");
// dotenv 기본값은 process.cwd()의 .env만 찾음 — 다른 폴더에서 node를 실행하면 비어 있음
const dotenvResult = require("dotenv").config({
  path: ENV_PATH,
  override: true,
});

if (dotenvResult.error) {
  console.warn(
    "[todo-backend] .env 로드 실패:",
    dotenvResult.error.message,
    `→ ${ENV_PATH}`
  );
} else if (!fs.existsSync(ENV_PATH)) {
  console.warn("[todo-backend] .env 파일이 없습니다 →", ENV_PATH);
} else if (
  !dotenvResult.parsed ||
  !Object.prototype.hasOwnProperty.call(dotenvResult.parsed, "MONGODB_URI")
) {
  console.warn(
    "[todo-backend] .env에 MONGODB_URI= 줄이 없습니다. 키 철자·대소문자를 확인하세요."
  );
}

require("./models/Todo");

const app = express();
// macOS는 5000번 포트를 AirPlay Receiver에 쓰므로 Express와 충돌함 — 기본값은 5001 사용
let PORT = Number(process.env.PORT) || 5001;
if (PORT === 5000) {
  console.warn(
    "[todo-backend] PORT=5000은 macOS에서 AirPlay(AirTunes)와 충돌합니다. 5001로 바꿉니다. 프론트 fetch 주소도 http://localhost:5001 로 맞추세요."
  );
  PORT = 5001;
}
// Mongo: MONGODB_URI(Atlas 등) 우선. 로컬 폴백은 USE_LOCAL_MONGO=true 일 때만 — 그렇지 않으면 Atlas 아닌 DB에 조용히 붙는 실수 방지
const LOCAL_MONGO_FALLBACK_URI = "mongodb://127.0.0.1:27017/todo-backend";
const mongoUriFromEnv =
  typeof process.env.MONGODB_URI === "string"
    ? process.env.MONGODB_URI.trim()
    : "";

/** Atlas 드라이버 권장 옵션. 이미 URI에 있으면 덮어쓰지 않음 */
function withAtlasDefaults(uri) {
  const s = String(uri).trim();
  if (!s.startsWith("mongodb+srv://")) return s;
  if (/[?&]retryWrites=/.test(s)) return s;
  const j = s.includes("?") ? "&" : "?";
  return `${s}${j}retryWrites=true&w=majority`;
}

let MONGODB_URI;
let mongoFromEnv;
if (mongoUriFromEnv !== "") {
  MONGODB_URI = withAtlasDefaults(mongoUriFromEnv);
  mongoFromEnv = true;
} else if (process.env.USE_LOCAL_MONGO === "true") {
  MONGODB_URI = LOCAL_MONGO_FALLBACK_URI;
  mongoFromEnv = false;
  console.warn(
    "[todo-backend] USE_LOCAL_MONGO=true 이므로 로컬 Mongo만 사용합니다 (127.0.0.1:27017/todo-backend)."
  );
} else {
  console.error(
    `[todo-backend] MONGODB_URI가 비어 있습니다. Atlas의 /todo DB를 쓰려면 .env(또는 셸)에 MONGODB_URI를 넣으세요.
로컬 Mongo만 쓸 때만 USE_LOCAL_MONGO=true 를 추가하세요.`
  );
  process.exit(1);
}

function mongoUriSummary(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return "(URI 파싱 실패)";
  }
}

// 기본 CORS: CLIENT_ORIGIN 미설정 시 요청 Origin 그대로 허용(로컬 여러 포트 대응). 운영은 CLIENT_ORIGIN으로 고정 권장
const corsOrigin =
  process.env.CLIENT_ORIGIN && String(process.env.CLIENT_ORIGIN).trim()
    ? String(process.env.CLIENT_ORIGIN)
        .split(",")
        .map((o) => o.trim())
    : true;

console.log("[todo-backend] NODE_ENV:", process.env.NODE_ENV || "(unset)");
console.log(
  "[todo-backend] API 오류 상세: 기본 포함. 숨기려면 TODO_HIDE_ERROR_DETAILS=true"
);
if (process.env.CLIENT_ORIGIN && String(process.env.CLIENT_ORIGIN).trim()) {
  console.log("[todo-backend] CLIENT_ORIGIN:", corsOrigin);
} else {
  console.log(
    "[todo-backend] CLIENT_ORIGIN 미설정 → 모든 Origin 허용 · Vite가 5174 등으로 바뀌어도 CORS 문제 없음"
  );
}

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);
app.use(express.json());
const todosRouter = require("./routers/todos");
app.use(
  "/todos",
  (req, res, next) => {
    if (mongoose.connection.readyState !== 1) {
      res.status(503).json({
        message:
          "MongoDB 연결 중입니다. 터미널에 '연결 성공'이 뜬 뒤 몇 초 뒤 새로고침 해 주세요.",
      });
      return;
    }
    next();
  },
  todosRouter
);

app.get("/", (req, res) => {
  res.send("Todo backend server is running.");
});

// 실제로 어느 DB에 붙었는지 확인용 (비밀번호 없이 호스트·DB명만)
app.get("/debug/db", (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ ok: false, message: "MongoDB 연결 전이거나 끊김" });
    return;
  }
  res.json({
    ok: true,
    mongoUriUsedFromEnv: mongoFromEnv,
    uriSummary: mongoUriSummary(MONGODB_URI),
    databaseName: mongoose.connection.db?.databaseName,
    host: mongoose.connection.host,
  });
});

// express.json() 파싱 실패 등
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    res.status(400).json({
      message:
        "요청 본문이 올바른 JSON이 아닙니다. Content-Type: application/json 과 형식을 확인하세요.",
    });
    return;
  }
  next(err);
});

app.use((err, req, res, next) => {
  console.error("[미처리 오류]", err.stack || err);
  const dev = process.env.NODE_ENV !== "production";
  res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500).json({
    message: dev ? err.message : "서버 오류가 발생했습니다.",
  });
});

const startServer = async () => {
  console.log(
    "[todo-backend] MongoDB 대상:",
    mongoUriSummary(MONGODB_URI),
    mongoFromEnv
      ? "(MONGODB_URI — Atlas 등 원격)"
      : "(로컬 폴백 — USE_LOCAL_MONGO=true)"
  );

  // Atlas 연결은 수십 초 걸릴 수 있음. listen을 먼저 열어 두면 / 와 프록시 TCP는 바로 붙음 (GET /todos 는 연결 후 쿼리)
  await new Promise((resolve, reject) => {
    const server = app.listen(PORT, () => {
      console.log(`서버 실행 중: http://localhost:${PORT}`);
      resolve(undefined);
    });
    server.on("error", reject);
  });

  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 45_000,
      socketTimeoutMS: 45_000,
    });
    console.log("연결 성공");

    const dbName = mongoose.connection.db.databaseName;
    const todoCount = await mongoose.connection.db
      .collection("todos")
      .countDocuments();
    console.log(
      `[todo-backend] 실제 사용 중인 DB 이름: "${dbName}" · todos 문서 수: ${todoCount}`
    );
    let expectedDb = "";
    try {
      const p = new URL(MONGODB_URI).pathname.replace(/^\/|\/$/g, "");
      expectedDb = p.split("/")[0] || "";
    } catch {
      /* ignore */
    }
    if (mongoFromEnv && expectedDb && dbName !== expectedDb) {
      console.warn(
        `[todo-backend] URI 경로의 DB 이름("${expectedDb}")과 실제 연결 DB("${dbName}")가 다릅니다. MONGODB_URI 끝의 /데이터베이스이름 을 확인하세요.`
      );
    }
  } catch (error) {
    console.error("MongoDB 연결 실패:", error.message);
    process.exit(1);
  }
};

startServer();
