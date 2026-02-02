const router = require("express").Router();
const mutualAid = require("../services/mutualAid.service");

function toErrorPayload(err) {
  const data = err?.response?.data;
  if (data) return typeof data === "string" ? data : data;
  return err?.message || "Unknown error";
}

router.get("/", (req, res) => {
  try {
    const out = mutualAid.list();
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.post("/", async (req, res) => {
  try {
    const out = await mutualAid.create({
      type: req.body?.type,
      title: req.body?.title,
      expireEnabled: req.body?.expireEnabled,
      expireAt: req.body?.expireAt,
      groupMode: req.body?.groupMode,
      existingGroupId: req.body?.existingGroupId,
    });
    res.json({ success: true, item: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const out = await mutualAid.update({
      id: req.params.id,
      type: req.body?.type,
      title: req.body?.title,
      expireEnabled: req.body?.expireEnabled,
      expireAt: req.body?.expireAt,
    });
    res.json({ success: true, item: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const out = await mutualAid.remove({ id: req.params.id });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.get("/:id/qr", async (req, res) => {
  try {
    const out = await mutualAid.getQr({ id: req.params.id });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.get("/:id/qr/download", async (req, res) => {
  try {
    const out = await mutualAid.getQrDownload({ id: req.params.id });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
    res.send(out.pngBuffer);
  } catch (err) {
    res.status(400).send(toErrorPayload(err));
  }
});

module.exports = router;
