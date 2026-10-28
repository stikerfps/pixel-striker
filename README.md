# Pixel Strike — multiplayer server setup

This folder is the whole online game: one small server that runs the website, live matches, accounts and saves.

- **Real multiplayer:** up to 10 players per lobby, and extra players go into a new lobby automatically. All lobbies share the 3-minute map rotation. There are no bots.
- **Accounts:** username + password, no email. Each username can only exist once, and players stay logged in on their device.
- **Saved on the server:** ELO, rank, coins, crate knives, loadout and name. Kills, coins and crate rolls are worked out by the server, so players can't give themselves stuff.
- **One admin:** only **Gus** gets the Admin panel. It can give coins, ELO and knives, change health and god mode, change the map for every lobby, send announcements, ban and unban, and back up everything.

Everything below is free. It takes about 20 minutes, and you need an email address to sign up for the three services.

---

## Step 1 — Put the files on GitHub

1. Make a free account at **https://github.com**.
2. Click **+ → New repository**. Name it `pixel-strike-server`, choose **Public**, and click **Create repository**.
3. Click **uploading an existing file**. Drag in everything inside this folder: `server.js`, `package.json`, `README.md`, `.gitignore` and the **`public`** folder. Then click **Commit changes**.
   - Make sure the `public` folder (with `index.html` and `knives` inside it) shows up in the repository.

## Step 2 — Make the free save database (Upstash)

Without this, the free host wipes saves whenever the server restarts.

1. Go to **https://upstash.com** and sign up (free).
2. Click **Create Database** (Redis). Name it `pixel-strike`, pick the region closest to you (for example *US-East*), keep the **Free** plan, and click **Create**.
3. On the database page, scroll to **REST API** and keep that page open. You'll need these two values in Step 3:
   - `UPSTASH_REDIS_REST_URL` (starts with `https://`)
   - `UPSTASH_REDIS_REST_TOKEN` (a long code). Treat this like a password and don't post it anywhere.

## Step 3 — Run the server (Render)

1. Go to **https://render.com** and sign up with your GitHub account.
2. Click **New → Web Service** and pick your `pixel-strike-server` repository.
3. Fill in:
   - **Runtime:** Node
   - **Build Command:** leave it blank (or `npm install`)
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
4. Open **Environment Variables** and add three:

| Key | Value |
|---|---|
| `ADMIN_USER` | `Gus` |
| `UPSTASH_REDIS_REST_URL` | the URL from Step 2 |
| `UPSTASH_REDIS_REST_TOKEN` | the token from Step 2 |

5. Click **Create Web Service**. After a minute or two the log says `Pixel Strike server running…` and your game is live at an address like `https://pixel-strike-server.onrender.com`.

## Step 4 — Claim the admin account, then share

1. Open your game link and **create the account `Gus` first**. Usernames are one-of-a-kind, so whoever makes Gus first owns it. That should be you.
2. The **Admin** button now shows in the menu and in matches. You can also press **P**.
3. Share the link. On iPad: open it in Safari → Share → **Add to Home Screen**.

---

## Good to know

- **First visit can be slow.** Render's free plan puts the server to sleep after 15 minutes with nobody playing. The next visitor waits about a minute while it wakes up. After that it's fast.
- **Updating the game:** upload a new `public/index.html` (or `server.js`) to your GitHub repository. Render rebuilds automatically in a couple of minutes. Saves are kept, because they live in Upstash.
- **Changing the admin:** edit `ADMIN_USER` in Render → your service → **Environment**. Only one username is admin at a time.
- **Backups:** as Gus, open **Settings → Download full backup**. It saves every player's account and progress in one file. **Restore full backup** loads it back in.
- **Moving to a new host:** put the same files on the new host and use the same two Upstash values. Everyone keeps their account and progress. If you also change databases, download a full backup first and restore it on the new server.
- **Testing on your own computer:** install Node.js from nodejs.org, open a terminal in this folder, and run `node server.js`. Then open `http://localhost:3000`. Saves go into `data.json` in this folder.
- **School network:** if your school blocks the site, that's their call. Ask IT or a teacher about allowing it rather than trying to get around the block.
- **Limits:** the free plans comfortably handle a school's worth of players. Each player only needs a small, steady amount of internet while playing.
