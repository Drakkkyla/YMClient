# YMClient

Альтернативный десктоп‑клиент Яндекс Музыки: Tauri 2 (Rust) + vanilla JS.

## Запуск

```bash
npm install
npm run tauri dev      # разработка
npm run tauri build    # установщик в src-tauri/target/release/bundle
```

## Что умеет
- Вход через окно Яндекс OAuth (или вставкой OAuth‑токена); токен лежит в `%APPDATA%\com.ymclient.app\config.json`.
- Моя волна с фидбеком (старт/пропуск/дослушал/лайк/дизлайк) и настройками характера и настроения.
- Поиск, страницы альбома, исполнителя и плейлиста, «Мне нравится», медиатека.
- Очередь, shuffle/repeat, медиаклавиши и оверлей Windows (Media Session), горячие клавиши.
- Визуализация на реальном спектре (Web Audio), фон в цвет обложки.
- Встроенный Discord Rich Presence (включается в настройках).

Горячие клавиши: `Space` — пауза, `←/→` — ±10 с, `Ctrl+←/→` — трек, `↑/↓` — громкость, `Ctrl+F` — поиск.

## Устройство
- `src-tauri/src/api.rs` — прокси к `api.music.yandex.net` (заголовки, токен) и подпись ссылок на mp3.
- `src-tauri/src/rpc.rs` — Discord RPC в отдельном потоке.
- `src/lib/player.js` — движок воспроизведения, `src/views.js` — экраны, `src/viz.js` — визуализация.

Аудио идёт через собственный протокол `ymstream:` (`src-tauri/src/stream.rs`): Rust сам качает поток
кусками по 2 МБ и отдаёт его плееру с открытым CORS. CDN Яндекса пускает только `localhost` /
`tauri.localhost`, а на macOS страница открывается с `tauri://localhost`, так что без прокси там не
работали бы эквалайзер, визуализатор и кроссфейд.

## macOS

С Windows macOS-сборку не сделать — нужен Mac. Проще всего через GitHub Actions
(`.github/workflows/build-macos.yml`): запушить проект на GitHub → вкладка Actions → «Build macOS» →
Run workflow → скачать `.dmg` из Artifacts. Сборка универсальная (Apple Silicon + Intel).

Приложение не подписано, поэтому при первом запуске: правый клик → «Открыть» → «Открыть».
Окно на Mac использует родные «светофоры» (`src-tauri/tauri.macos.conf.json`).
