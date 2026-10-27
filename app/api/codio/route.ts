export async function POST() {
  return Response.json({
    error: "CODIO_AI_DESKTOP_ONLY",
    message: "AI DJ is available in the CODIO desktop app with an on-device encrypted DeepSeek key.",
  }, { status: 503 });
}
