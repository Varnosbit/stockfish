.eval const Canvas = require("canvas");
const ch = 638 * 2.4, cw = 480 * 2.4;
const card = Canvas.createCanvas(cw, ch), ctx = card.getContext("2d");
ctx.fillStyle = "#E5E7EB";
ctx.fillRect(0, 0, cw, ch);

const cs = 48 * 2, gc = Math.ceil(cw / cs), gr = Math.ceil(ch / cs);

ctx.strokeStyle = "rgba(0,0,0,0.05)";
ctx.lineWidth = 2;

for (let r = 0; r < gr; r++) {
  for (let col = 0; col < gc; col++) {
    const x = col * cs, y = r * cs;
    ctx.strokeRect(x, y, cs, cs);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + cs, y + cs);
    ctx.stroke(); 
  }
}

ctx.fillStyle = "#0E131D";
ctx.fillRect(0, 0, cw, 200);

const lineHeight = 6;
const gradient = ctx.createLinearGradient(0, 200, cw, 200);
gradient.addColorStop(0, "#2E0A4F");
gradient.addColorStop(0.5, "#A855F7");
gradient.addColorStop(1, "#2E0A4F");

ctx.fillStyle = gradient;
ctx.fillRect(0, 200, cw, lineHeight);

const logo = await Canvas.loadImage("https://webusstatic.yo-star.com/arknights-us/arknights-us-website/main/h5/assets/logo-4f95ced5.png");
ctx.drawImage(logo, cw-logo.width-60, 50);

const pfpSize = 120;
const pfpX = 50;
const pfpY = 32;

const pfp = await Canvas.loadImage(
  (await usersData.get(event.senderID))?.data?.status?.avatar || await usersData.getAvatarUrl(event.senderID));

ctx.save();
ctx.beginPath();
ctx.arc(pfpX + pfpSize / 2, pfpY + pfpSize / 2, pfpSize / 2, 0, Math.PI * 2);
ctx.closePath();
ctx.clip();
ctx.drawImage(pfp, pfpX, pfpY, pfpSize, pfpSize);
ctx.restore();

ctx.beginPath();
ctx.arc(pfpX + pfpSize / 2, pfpY + pfpSize / 2, pfpSize / 2 + 3, 0, Math.PI * 2);
ctx.strokeStyle = gradient;
ctx.lineWidth = 4;
ctx.stroke();

ctx.font = "600 25px sans-serif";
ctx.fillStyle = "#B4BAC7";

const nameX = pfpX + pfpSize + 18;
ctx.textAlign = "left";

ctx.font = "700 34px Arial";
ctx.fillStyle = "#FFFFFF";
ctx.fillText("ALLOU MOHAMED", nameX, 80);

sh.canvas(card);