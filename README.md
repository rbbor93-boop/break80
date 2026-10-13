# Break80

A phone-first golf stats app for a group of players. Pick a course by GPS, log each hole, and compare stats and trends with everyone else in the group.

- **Shared password** to get in, then each player creates a **profile with a 4-digit PIN**. Several players can share one phone and switch between profiles.
- **Everyone's rounds are visible to everyone** in the app (leaderboard, latest rounds, each player's stats). Only the owner, with their PIN, can add, edit or delete their rounds.
- **Stats per hole:** score, putts, first-putt distance, fairway (left / hit / right), green in regulation (worked out automatically), GIR+1, 3-putts, penalties, bogey with a wedge in hand, par-5 bogeys, par-3 short-sided.
- **Trends:** every stat has a chart over time, a result for each round, and an improving / getting-worse indicator.
- **Works with no signal:** rounds save on the phone first and upload when there's a connection.

## How it fits together

| Part | Where |
| --- | --- |
| App (static HTML/JS/CSS) | GitHub Pages |
| Players, rounds, shared scorecards | Supabase Postgres ([`supabase/schema.sql`](supabase/schema.sql)) |
| Nearby courses | OpenStreetMap (Overpass API) |
| Scorecards (par, yardage, handicap) | [GolfCourseAPI](https://golfcourseapi.com) |

The browser never reads the database tables directly. It can only call the `b80_*` functions. Each of them checks the shared password, and anything that changes a player's data also checks that player's PIN. Passwords and PINs are stored as bcrypt hashes. Five wrong PINs lock a profile for 15 minutes. The GolfCourseAPI key lives in the database and is only given to people who know the password.

**Not covered by this setup:** it's sized for a group of friends, not for strangers. Anyone who knows the shared password can read every player's rounds and can see the golf API key. A 4-digit PIN is a light barrier, not strong security.

## Setup

1. Create a Supabase project. In the SQL editor, run [`supabase/schema.sql`](supabase/schema.sql).
2. Set the password and golf API key (keep this out of git):
   ```sql
   insert into b80_config (id, password_hash, golf_api_key)
   values (1, extensions.crypt('<password>', extensions.gen_salt('bf')), '<golfcourseapi key>')
   on conflict (id) do update set password_hash = excluded.password_hash, golf_api_key = excluded.golf_api_key;
   ```
3. Put the project URL and publishable (anon) key in [`config.js`](config.js). Both are safe to publish.
4. Push to GitHub with Pages enabled for the `main` branch. GPS needs the HTTPS address that Pages provides.
5. On your phone, open the site and add it to your home screen (Safari: Share → *Add to Home Screen*).

When you deploy changes, bump `VERSION` in [`sw.js`](sw.js) so phones pick up the new files.
