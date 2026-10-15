// Runs once, when the MongoDB volume is first created: a least-privilege user
// for the app (read/write on the safeprint database only).
db.getSiblingDB("safeprint").createUser({
  user: "safeprint",
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [{ role: "readWrite", db: "safeprint" }],
});
