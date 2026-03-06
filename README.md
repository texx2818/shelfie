# shelfie

personal self-hosted catalog for your physical media. books, movies, music, games — anything you own.

## running with docker

download the zip. run the docker compose.

```bash
docker compose up -d
```

Open [http://localhost:4120](http://localhost:4120).

Data is stored in a named Docker volume and survives container restarts and upgrades.

## Adding items

- **Barcode / ISBN** — type or scan a barcode; Shelfie looks it up in Open Library (books) or UPC Item DB (everything else)
- **Title search** — searches Open Library, OMDb, MusicBrainz, and RAWG depending on the selected type
- **Manual entry** — fill in the form directly
- **CSV import** — bulk-import from a spreadsheet

## CSV format

Column names are case-insensitive. `title` is the only required field.

| Column | Notes |
|---|---|
| `title` | Required |
| `creator` | Also accepts `author` or `artist` |
| `type` | `book` `movie` `music` `game` `tv` `other` |
| `year` | |
| `barcode` | Also accepts `isbn` |
| `genre` | |
| `format` | e.g. Blu-ray, Vinyl, Hardback |
| `rating` | 1–5 |
| `notes` | |
| `status` | `owned` `wishlist` `lent` `sold` |
| `cover_url` | |

Export your library at any time via the **↓ Export CSV** button.

## Backups

The database lives at `/data/shelfie.db` inside the container.

```bash
# Back up
docker cp shelfie:/data/shelfie.db ./shelfie.db

# Restore
docker cp ./shelfie.db shelfie:/data/shelfie.db
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4120` | HTTP port |
| `DB_PATH` | `/data/shelfie.db` | SQLite database path |

## License

MIT
