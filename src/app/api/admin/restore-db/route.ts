export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.DATABASE_URL || path.join(process.cwd(), "data", "the-frame.db");

export async function POST(request: NextRequest) {
  const key = request.headers.get("x-admin-key");
  if (key !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { action, data, chunk } = body;

  if (action === "start") {
    // Start fresh upload
    const tmpPath = DB_PATH + ".upload";
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    fs.writeFileSync(tmpPath, Buffer.alloc(0));
    return NextResponse.json({ status: "ready", tmpPath });
  }

  if (action === "chunk" && data) {
    // Append base64 chunk
    const tmpPath = DB_PATH + ".upload";
    const buf = Buffer.from(data, "base64");
    fs.appendFileSync(tmpPath, buf);
    const size = fs.statSync(tmpPath).size;
    return NextResponse.json({ status: "ok", chunk, size });
  }

  if (action === "finish") {
    // Swap files
    const tmpPath = DB_PATH + ".upload";
    if (!fs.existsSync(tmpPath)) {
      return NextResponse.json({ error: "no upload in progress" }, { status: 400 });
    }
    const size = fs.statSync(tmpPath).size;
    
    // Remove WAL/SHM
    try { fs.unlinkSync(DB_PATH + "-shm"); } catch {}
    try { fs.unlinkSync(DB_PATH + "-wal"); } catch {}
    
    // Replace
    fs.renameSync(tmpPath, DB_PATH);
    
    return NextResponse.json({ status: "complete", size });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
