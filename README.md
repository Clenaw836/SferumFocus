SferumFocus — цифровая образовательная среда

<p align="center">
  <strong>СферумФокус</strong><br/>
  Интеллектуальная платформа для организации учебного процесса, работы учителя и персонального сопровождения ученика.
</p>Проект хакатона «Идея-Фикс»

---

О проекте

СферумФокус — веб-приложение, объединяющее инструменты для учеников и педагогов в единой цифровой образовательной среде.

Платформа помогает организовать учебную деятельность, отслеживать успеваемость, работать с заданиями, планировать уроки и управлять учебными материалами.

Проект ориентирован на создание удобного цифрового пространства, в котором ученик получает инструменты для самостоятельного обучения, а учитель — инструменты для организации и анализа образовательного процесса.

Основные возможности

Для ученика

- Персональный учебный профиль.
- Работа с домашними заданиями.
- Планирование учебного дня.
- Отслеживание прогресса и успеваемости.
- Учебные тренировки и интерактивные задания.
- Персональный помощник и инструменты работы с учебным материалом.

Для учителя

- Кабинет учителя.
- Работа с классами и учениками.
- Управление учебными заданиями.
- Электронный табель успеваемости.
- Инструменты формирования критериев оценивания.
- Калькулятор результатов и оценок.
- Банк комментариев для обратной связи.
- Конструктор плана урока.
- Экспорт данных в XLSX, CSV, TSV, JSON и HTML.

Демонстрационный режим

В проекте предусмотрена изолированная демонстрационная среда:

- Демонстрационные профили учителя и учеников.
- Синтетические учебные данные.
- Переключение между ролями.
- Отдельная демосессия.
- Изоляция демонстрационных данных от обычных пользовательских данных.

Демонстрационный режим не требует настоящих школьных аккаунтов, токенов MAX или подключения к СГО.

Запуск готового Docker-образа

Для проверки проекта жюри предоставляется готовый Docker-образ.

Исходный код, Python, Node.js и сборка проекта на сервере не требуются.

1. Системные требования

Рекомендуемая конфигурация сервера:

Компонент| Требование
ОС| Ubuntu Server 22.04 / 24.04
Процессор| 2 CPU
Оперативная память| От 2 ГБ
Дисковое пространство| От 3 ГБ свободного места
Контейнеризация| Docker Engine
Сеть| Интернет для установки Docker
Порт| 8001

2. Установка Docker

Подключитесь к серверу по SSH:

ssh user@SERVER_IP

Обновите систему и установите необходимые утилиты:

sudo apt update
sudo apt install -y ca-certificates curl

Добавьте официальный репозиторий Docker:

sudo install -m 0755 -d /etc/apt/keyrings

sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc

sudo chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

Установите Docker Engine и необходимые компоненты:

sudo apt update

sudo apt install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

Запустите Docker и добавьте его в автозагрузку:

sudo systemctl enable --now docker

Проверьте установку:

sudo docker run hello-world

3. Загрузка Docker-образа

Скопируйте предоставленный архив "SferumFocus_Docker_Image.tar.gz" на сервер.

Например, с локального компьютера:

scp SferumFocus_Docker_Image.tar.gz user@SERVER_IP:~/

Загрузите образ в Docker:

sudo docker load -i ~/SferumFocus_Docker_Image.tar.gz

Проверьте наличие образа:

sudo docker images

Используемый тег образа:

sferumfocus:ai-consent-toggle

4. Подготовка демонстрационной конфигурации

Создайте файл конфигурации:

cat > jury.env <<'EOF'
SFERUM_ENV=demo
SFERUM_DEMO_SANDBOX=1
SFERUM_LOCAL_SECRETS=1
SFERUM_USE_MOCK=1
SCHEDULE_DEMO=1
SFERUM_DATA_DIR=/code/data
SFERUM_WORKERS=1
SFERUM_REPLICAS=1
SFERUM_STORAGE_KIND=local-posix
SFERUM_PUBLIC_ORIGIN=http://127.0.0.1:8001
PORT=8000
PLATFORM_AUTH_ENABLED=1
MAX_REQUIRE_AUTH=0
SGO_TEACHER_WRITE=0
ENABLE_DIARY_WATCHER=0
ENABLE_ESIA_AUTH=false
MAX_BOT_MODE=disabled
MAX_WEBHOOK_AUTO_REGISTER=0
EXTERNAL_AI_ENABLED=0
GROQ_API_KEY=
GROQ_PROXY_URL=
MAX_BOT_TOKEN=
TELEGRAM_BOT_TOKEN=
SESSION_SIGNING_KEY=
DIARY_ENCRYPTION_KEY=
DEMO_SANDBOX_KEY=
SFERUM_API_TOKEN=
SCHEDULE_FEED_URL=
SCHEDULE_FEED_TOKEN=
TEACHER_DIRECTORY_FILE=
EOF

Ограничьте доступ к конфигурации:

chmod 600 jury.env

5. Запуск приложения

Создайте Docker Volume для сохранения данных:

sudo docker volume create sferumfocus_data

Запустите контейнер:

sudo docker run -d \
  --name sferumfocus \
  --restart unless-stopped \
  --env-file jury.env \
  -p 127.0.0.1:8001:8000 \
  -v sferumfocus_data:/code/data \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 1536m \
  --cpus 2.0 \
  sferumfocus:ai-consent-toggle

После запуска Docker автоматически использует встроенную конфигурацию запуска приложения.

6. Проверка работоспособности

Проверьте состояние контейнера:

sudo docker ps

Проверьте встроенный Health Check:

sudo docker inspect \
  --format='{{.State.Health.Status}}' \
  sferumfocus

Просмотрите журналы приложения:

sudo docker logs --tail 100 sferumfocus

Для просмотра логов в реальном времени:

sudo docker logs -f sferumfocus

7. Открытие приложения

Приложение доступно по адресу:

http://127.0.0.1:8001/?demo=live

Если сервер удалённый, создайте SSH-туннель на своём компьютере:

ssh -L 8001:127.0.0.1:8001 user@SERVER_IP

После подключения откройте в браузере:

http://127.0.0.1:8001/?demo=live

Параметр "demo=live" активирует демонстрационную сессию.

В демонстрационной среде можно проверить интерфейс учителя, переключение ролей, ученические профили и доступные инструменты.

8. Управление контейнером

Просмотр состояния:

sudo docker ps -a

Просмотр логов:

sudo docker logs sferumfocus

Перезапуск:

sudo docker restart sferumfocus

Остановка:

sudo docker stop sferumfocus

Повторный запуск:

sudo docker start sferumfocus

Удаление контейнера:

sudo docker rm -f sferumfocus

Удаление демонстрационных данных:

sudo docker volume rm sferumfocus_data

Внимание: удаление Docker Volume приводит к безвозвратному удалению сохранённых в нём данных.

Безопасность и ограничения демонстрационной версии

- Демонстрация работает с синтетическими данными.
- Интеграция с внешним AI отключена.
- Интеграция с MAX и Telegram отключена.
- Запись оценок во внешнюю систему СГО отключена.
- Демонстрационные данные изолированы от обычных пользовательских данных.
- Контейнер работает от непривилегированного пользователя.
- Доступ к сервису по умолчанию ограничен локальным интерфейсом сервера.

Демонстрационная конфигурация предназначена для локальной проверки и презентации проекта. Она не является production-конфигурацией для публичного размещения.

Технологический стек

- Backend: Python 3.13, FastAPI, Uvicorn.
- Frontend: React, TypeScript.
- Контейнеризация: Docker.
- Хранение данных: локальное файловое хранилище.
- Обработка изображений: Pillow, Tesseract OCR.
- Асинхронная обработка: asyncio, uvloop.

Структура поставки для жюри

Для запуска необходимы:

SferumFocus/
├── README.md
├── requirement.txt
└── SferumFocus_Docker_Image.tar.gz

Исходный код для запуска приложения не требуется.

Разработано для хакатона «Идея-Фикс»

СферумФокус — единое цифровое пространство для ученика и учителя.
