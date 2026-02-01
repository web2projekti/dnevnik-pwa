import webpush from "web-push";
const keys = webpush.generateVAPIDKeys();
process.stdout.write(
  `VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\nVAPID_SUBJECT=mailto:ti@domain.com\n`
);