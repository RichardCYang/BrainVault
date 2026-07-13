const languageStorageKey = "brainvault.language";

export const supportedLanguages = Object.freeze([
  { code: "en", locale: "en-US", label: "English" },
  { code: "ja", locale: "ja-JP", label: "日本語" },
  { code: "ko", locale: "ko-KR", label: "한국어" },
  { code: "fr", locale: "fr-FR", label: "Français" },
  { code: "de", locale: "de-DE", label: "Deutsch" },
  { code: "es", locale: "es-ES", label: "Español" },
  { code: "pt", locale: "pt-BR", label: "Português" }
]);

const supportedLanguageCodes = new Set(supportedLanguages.map(({ code }) => code));

export const translationCatalogs = {
  en: {
    meta: { description: "BrainVault - a Notion-style notes app built with Markdown blocks" },
    language: { label: "Language" },
    sidebar: { aria: "BrainVault sidebar", homeAria: "BrainVault home" },
    brand: { eyebrow: "Private workspace" },
    auth: {
      loginKicker: "Welcome back",
      registerKicker: "Create account",
      loginTitle: "Log in",
      registerTitle: "Sign up",
      loginDescription: "Enter your ID and password so you can focus on writing notes.",
      registerDescription: "Create a new BrainVault account with an ID and password.",
      username: "ID",
      password: "Password",
      name: "Name",
      optional: "Optional",
      namePlaceholder: "Vault Keeper",
      login: "Log in",
      register: "Sign up",
      loginSwitch: "New to BrainVault?",
      registerSwitch: "Already have an account?"
    },
    workspace: { aria: "Workspace navigation", logout: "Log out" },
    search: { label: "Search pages and blocks", placeholder: "Search pages/blocks", button: "Search" },
    navigation: { aria: "Default collection and page list" },
    collection: {
      heading: "📁 Default collection",
      addAria: "Add a new page to the default collection",
      addTitle: "Add new page",
      description: "Press + to instantly create a page titled ‘Untitled’."
    },
    home: {
      kicker: "BrainVault workspace",
      title: "Capture your thoughts with ease.",
      description: "Bring scattered ideas and tasks into one place. Create pages, stack blocks, and find what you need in moments.",
      newPage: "Create new page",
      recent: "Recent pages",
      quickStart: "Quick start",
      steps: "3 steps",
      guide1Title: "1. Create a new page",
      guide1Description: "Start instantly with the + in the sidebar or the button above.",
      guide2Title: "2. Organize the title and tags",
      guide2Description: "Make each page's context easy to understand at a glance.",
      guide3Title: "3. Choose a block with /",
      guide3Description: "Quickly add text, headings, tasks, tables, and code blocks."
    },
    page: {
      titleAria: "Page title",
      save: "Save",
      archive: "Archive",
      tags: "Tags",
      tagsPlaceholder: "Separate tags with commas",
      content: "Page content",
      editorHelp: "Press <kbd>Enter</kbd> for a new block · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a line break · <kbd>Backspace</kbd> on an empty block to delete it",
      editorAria: "Unified block document editor"
    },
    menu: {
      slashAria: "Choose block type",
      blockAria: "Block actions",
      addBlock: "Add block",
      insertBefore: "Add block above",
      insertAfter: "Add block below",
      calloutType: "Callout type",
      saveBlock: "Save block",
      deleteBlock: "Delete block"
    },
    toolbar: {
      aria: "Format selected text",
      bold: "Bold",
      italic: "Italic",
      strike: "Strikethrough",
      code: "Inline code",
      link: "Link",
      colorDefault: "Default text color",
      colorSky: "Sky blue text",
      colorBlue: "Blue text",
      colorRed: "Red text",
      colorGreen: "Green text"
    },
    blocks: {
      types: {
        MARKDOWN: "Text",
        HEADING_1: "Heading 1",
        HEADING_2: "Heading 2",
        HEADING_3: "Heading 3",
        TODO: "To-do",
        QUOTE: "Quote",
        CALLOUT: "Callout",
        TABLE: "Table",
        CODE: "Code",
        DIVIDER: "Divider",
        IMAGE: "Image"
      }
    },
    callouts: { idea: "Idea", info: "Information", success: "Success", warning: "Warning", danger: "Danger" },
    slash: {
      MARKDOWN: { label: "Text", hint: "Plain Markdown block", keywords: "markdown text paragraph" },
      HEADING_1: { label: "Heading 1", hint: "Largest heading", keywords: "heading title h1" },
      HEADING_2: { label: "Heading 2", hint: "Medium heading", keywords: "heading subtitle h2" },
      HEADING_3: { label: "Heading 3", hint: "Small heading", keywords: "heading h3" },
      TODO: { label: "Checkbox", hint: "To-do block", keywords: "todo task check checkbox" },
      QUOTE: { label: "Quote", hint: "Quotation block", keywords: "quote quotation" },
      CALLOUT: { label: "Callout", hint: "Highlighted box", keywords: "callout notice highlight" },
      TABLE: { label: "Table", hint: "Simple editable rows and columns", keywords: "table grid rows columns" },
      CODE: { label: "Code", hint: "Code block", keywords: "code programming" },
      DIVIDER: { label: "Divider", hint: "Horizontal divider", keywords: "divider hr line separator" },
      IMAGE: { label: "Image", hint: "Image URL block", keywords: "image img photo picture" }
    },
    table: {
      toolbarAria: "Table editing tools",
      firstRow: "First row",
      firstRowTitle: "Use the first row as headers",
      firstColumn: "First column",
      firstColumnTitle: "Use the first column as headers",
      deleteRow: "− Row",
      deleteRowTitle: "Delete selected row",
      deleteColumn: "− Column",
      deleteColumnTitle: "Delete selected column",
      editableAria: "Editable table",
      cellAria: "Row {row}, column {column}",
      addColumn: "Add a column to the right edge of the table",
      addRow: "Add a row to the bottom of the table"
    },
    block: {
      dividerPlaceholder: "Divider block",
      contentPlaceholder: "Type content or '/' to choose a block type",
      contentAria: "{type} block content",
      handleTitle: "Drag to reorder · Click for block menu",
      handleAria: "Block reorder handle and block menu",
      meta: "Block · {date}",
      completed: "Done",
      saving: "Saving",
      saved: "Saved"
    },
    empty: {
      noSearchResults: "No pages match your filters. Try a different search.",
      noDocumentsSidebar: "No pages yet. Press + in the default collection to begin.",
      noDocumentsHome: "No pages yet. Press + in the default collection on the left to begin.",
      preparingBlock: "Preparing the first block for editing.",
      noSlashResults: "No matching block types."
    },
    counts: { documents: "{count} pages", blocks: "{count} blocks" },
    newDocumentTitle: "Untitled",
    position: { top: "above", bottom: "below" },
    confirm: {
      archivePage: "Archive this page? It will be hidden from the list.",
      deleteBlock: "Delete this block?"
    },
    status: {
      calloutChanged: "Changed the callout type to {type}.",
      savingBlockOrder: "Saving block order...",
      blockOrderChanged: "Block order updated.",
      blockSaved: "Block saved.",
      formatApplied: "Formatting applied to the selected text.",
      blockInserted: "Created a new block {position}. Type '/' to choose its type.",
      blockAppended: "Created a new block. Type '/' to choose its type.",
      emptyBlockDeleted: "Empty block deleted.",
      pageTitleSaved: "Page title saved.",
      creatingDocument: "Creating a page in the default collection...",
      documentCreated: "Page created. You can edit its title now.",
      loadingDocument: "Loading page...",
      documentOpened: "Page opened.",
      ready: "Ready.",
      getStarted: "Log in or sign up to get started.",
      loginRequired: "Please log in.",
      registerPrompt: "Enter your sign-up information.",
      loginPrompt: "Log in with your ID and password.",
      loggingIn: "Logging in...",
      registering: "Creating your account...",
      loggedInAs: "Starting with ID {username}.",
      loggedOut: "Logged out.",
      searchLoaded: "Search results loaded.",
      collectionOpened: "Default collection opened.",
      pageSaved: "Page saved.",
      pageArchived: "Page archived.",
      blockDeleted: "Block deleted.",
      languageChanged: "Language changed to {language}."
    },
    errors: {
      currentBlockOrder: "Could not find the current block order.",
      network: "Could not connect to the server. Check your network and try again.",
      invalidResponse: "The server returned an unreadable response.",
      VALIDATION_ERROR: "Please check the entered information.",
      ID_TAKEN: "That ID is already in use.",
      INVALID_CREDENTIALS: "The ID or password is incorrect.",
      INVALID_TOKEN: "Your session is invalid or has expired. Please log in again.",
      UNAUTHENTICATED: "Please log in to continue.",
      NOT_FOUND: "The requested item could not be found.",
      ROUTE_NOT_FOUND: "The requested endpoint could not be found.",
      DATABASE_CONSTRAINT_FAILED: "The request conflicts with existing data.",
      ER_DUP_ENTRY: "That value already exists.",
      INTERNAL_SERVER_ERROR: "An unexpected server error occurred.",
      USER_CREATE_FAILED: "The account could not be created.",
      BLOCK_CREATE_FAILED: "The block could not be created.",
      INVALID_BLOCKS: "The block order is invalid.",
      INVALID_PARENT_BLOCK: "The selected parent block is invalid.",
      INVALID_PARENT_PAGE: "The selected parent page is invalid.",
      unknown: "Something went wrong. Please try again."
    }
  },

  ja: {
    meta: { description: "BrainVault - Markdownブロックを使ったNotion風ノートアプリ" },
    language: { label: "言語" },
    sidebar: { aria: "BrainVault サイドバー", homeAria: "BrainVault ホーム" },
    brand: { eyebrow: "プライベートワークスペース" },
    auth: {
      loginKicker: "おかえりなさい",
      registerKicker: "アカウント作成",
      loginTitle: "ログイン",
      registerTitle: "新規登録",
      loginDescription: "ノート作成に集中できるよう、IDとパスワードを入力してください。",
      registerDescription: "IDとパスワードで新しいBrainVaultアカウントを作成します。",
      username: "ID",
      password: "パスワード",
      name: "名前",
      optional: "任意",
      namePlaceholder: "Vault Keeper",
      login: "ログイン",
      register: "新規登録",
      loginSwitch: "初めてご利用ですか？",
      registerSwitch: "すでにアカウントをお持ちですか？"
    },
    workspace: { aria: "ワークスペースナビゲーション", logout: "ログアウト" },
    search: { label: "ページとブロックを検索", placeholder: "ページ／ブロックを検索", button: "検索" },
    navigation: { aria: "デフォルトコレクションとページ一覧" },
    collection: {
      heading: "📁 デフォルトコレクション",
      addAria: "デフォルトコレクションに新しいページを追加",
      addTitle: "新しいページを追加",
      description: "+ を押すと「無題」のページがすぐに作成されます。"
    },
    home: {
      kicker: "BrainVault ワークスペース",
      title: "思考を気軽に記録しましょう。",
      description: "散らばったアイデアやタスクを一か所にまとめましょう。ページを作り、ブロックを積み重ね、必要なときにすぐ見つけられます。",
      newPage: "新しいページを作成",
      recent: "最近のページ",
      quickStart: "クイックスタート",
      steps: "3ステップ",
      guide1Title: "1. 新しいページを作成",
      guide1Description: "サイドバーの + または上のボタンからすぐ始められます。",
      guide2Title: "2. タイトルとタグを整理",
      guide2Description: "ページの内容がひと目で分かるように整理しましょう。",
      guide3Title: "3. / でブロックを選択",
      guide3Description: "テキスト、見出し、タスク、表、コードブロックをすばやく追加できます。"
    },
    page: {
      titleAria: "ページタイトル",
      save: "保存",
      archive: "アーカイブ",
      tags: "タグ",
      tagsPlaceholder: "タグをカンマで区切って入力",
      content: "ページ内容",
      editorHelp: "<kbd>Enter</kbd>で新しいブロック · <kbd>Shift</kbd> + <kbd>Enter</kbd>で改行 · 空のブロックで<kbd>Backspace</kbd>を押すと削除",
      editorAria: "統合ブロックドキュメントエディター"
    },
    menu: {
      slashAria: "ブロックタイプを選択",
      blockAria: "ブロック操作",
      addBlock: "ブロックを追加",
      insertBefore: "上にブロックを追加",
      insertAfter: "下にブロックを追加",
      calloutType: "コールアウトタイプ",
      saveBlock: "ブロックを保存",
      deleteBlock: "ブロックを削除"
    },
    toolbar: {
      aria: "選択テキストの書式設定",
      bold: "太字",
      italic: "斜体",
      strike: "取り消し線",
      code: "インラインコード",
      link: "リンク",
      colorDefault: "標準の文字色",
      colorSky: "空色の文字",
      colorBlue: "青色の文字",
      colorRed: "赤色の文字",
      colorGreen: "緑色の文字"
    },
    blocks: { types: { MARKDOWN: "テキスト", HEADING_1: "見出し 1", HEADING_2: "見出し 2", HEADING_3: "見出し 3", TODO: "タスク", QUOTE: "引用", CALLOUT: "コールアウト", TABLE: "表", CODE: "コード", DIVIDER: "区切り線", IMAGE: "画像" } },
    callouts: { idea: "アイデア", info: "情報", success: "成功", warning: "注意", danger: "危険" },
    slash: {
      MARKDOWN: { label: "テキスト", hint: "通常のMarkdownブロック", keywords: "markdown text 段落 テキスト" },
      HEADING_1: { label: "見出し 1", hint: "最も大きい見出し", keywords: "heading title 見出し h1" },
      HEADING_2: { label: "見出し 2", hint: "中くらいの見出し", keywords: "heading subtitle 見出し h2" },
      HEADING_3: { label: "見出し 3", hint: "小さい見出し", keywords: "heading 見出し h3" },
      TODO: { label: "チェックボックス", hint: "タスクブロック", keywords: "todo task check タスク チェック" },
      QUOTE: { label: "引用", hint: "引用文ブロック", keywords: "quote 引用" },
      CALLOUT: { label: "コールアウト", hint: "強調ボックス", keywords: "callout notice コールアウト 強調" },
      TABLE: { label: "表", hint: "行と列を編集できる簡単な表", keywords: "table grid 表 テーブル" },
      CODE: { label: "コード", hint: "コードブロック", keywords: "code コード" },
      DIVIDER: { label: "区切り線", hint: "横の区切り線", keywords: "divider hr line 区切り線" },
      IMAGE: { label: "画像", hint: "画像URLブロック", keywords: "image img 写真 画像" }
    },
    table: {
      toolbarAria: "表編集ツール",
      firstRow: "先頭行",
      firstRowTitle: "先頭行を見出しとして使用",
      firstColumn: "先頭列",
      firstColumnTitle: "先頭列を見出しとして使用",
      deleteRow: "− 行",
      deleteRowTitle: "選択した行を削除",
      deleteColumn: "− 列",
      deleteColumnTitle: "選択した列を削除",
      editableAria: "編集可能な表",
      cellAria: "{row}行 {column}列",
      addColumn: "表の右端に列を追加",
      addRow: "表の一番下に行を追加"
    },
    block: {
      dividerPlaceholder: "区切り線ブロック",
      contentPlaceholder: "内容を入力するか「/」でブロックタイプを選択",
      contentAria: "{type}ブロックの内容",
      handleTitle: "ドラッグして並べ替え · クリックしてブロックメニュー",
      handleAria: "ブロック並べ替えハンドルとブロックメニュー",
      meta: "ブロック · {date}",
      completed: "完了",
      saving: "保存中",
      saved: "保存済み"
    },
    empty: {
      noSearchResults: "条件に一致するページがありません。検索語を変えてみてください。",
      noDocumentsSidebar: "まだページがありません。デフォルトコレクションの + から始めましょう。",
      noDocumentsHome: "まだページがありません。左側のデフォルトコレクションの + から始めましょう。",
      preparingBlock: "編集用の最初のブロックを準備しています。",
      noSlashResults: "一致するブロックタイプがありません。"
    },
    counts: { documents: "{count}ページ", blocks: "{count}ブロック" },
    newDocumentTitle: "無題",
    position: { top: "上", bottom: "下" },
    confirm: { archivePage: "このページをアーカイブしますか？一覧から非表示になります。", deleteBlock: "このブロックを削除しますか？" },
    status: {
      calloutChanged: "コールアウトタイプを「{type}」に変更しました。",
      savingBlockOrder: "ブロックの順序を保存しています...",
      blockOrderChanged: "ブロックの順序を変更しました。",
      blockSaved: "ブロックを保存しました。",
      formatApplied: "選択したテキストに書式を適用しました。",
      blockInserted: "{position}に新しいブロックを作成しました。「/」を入力してタイプを選択してください。",
      blockAppended: "新しいブロックを作成しました。「/」を入力してタイプを選択してください。",
      emptyBlockDeleted: "空のブロックを削除しました。",
      pageTitleSaved: "ページタイトルを保存しました。",
      creatingDocument: "デフォルトコレクションに新しいページを作成しています...",
      documentCreated: "新しいページを作成しました。タイトルをすぐに編集できます。",
      loadingDocument: "ページを読み込んでいます...",
      documentOpened: "ページを開きました。",
      ready: "準備ができました。",
      getStarted: "ログインまたは新規登録して始めましょう。",
      loginRequired: "ログインが必要です。",
      registerPrompt: "新規登録情報を入力してください。",
      loginPrompt: "IDとパスワードでログインしてください。",
      loggingIn: "ログインしています...",
      registering: "アカウントを作成しています...",
      loggedInAs: "ID {username} で開始します。",
      loggedOut: "ログアウトしました。",
      searchLoaded: "検索結果を読み込みました。",
      collectionOpened: "デフォルトコレクションを開きました。",
      pageSaved: "ページを保存しました。",
      pageArchived: "ページをアーカイブしました。",
      blockDeleted: "ブロックを削除しました。",
      languageChanged: "言語を{language}に変更しました。"
    },
    errors: {
      currentBlockOrder: "現在のブロック順序を確認できません。",
      network: "サーバーに接続できません。ネットワークを確認して再度お試しください。",
      invalidResponse: "サーバーから読み取れない応答が返されました。",
      VALIDATION_ERROR: "入力内容を確認してください。",
      ID_TAKEN: "そのIDはすでに使用されています。",
      INVALID_CREDENTIALS: "IDまたはパスワードが正しくありません。",
      INVALID_TOKEN: "セッションが無効または期限切れです。もう一度ログインしてください。",
      UNAUTHENTICATED: "続行するにはログインしてください。",
      NOT_FOUND: "要求された項目が見つかりません。",
      ROUTE_NOT_FOUND: "要求されたエンドポイントが見つかりません。",
      DATABASE_CONSTRAINT_FAILED: "既存のデータと競合しています。",
      ER_DUP_ENTRY: "その値はすでに存在します。",
      INTERNAL_SERVER_ERROR: "予期しないサーバーエラーが発生しました。",
      USER_CREATE_FAILED: "アカウントを作成できませんでした。",
      BLOCK_CREATE_FAILED: "ブロックを作成できませんでした。",
      INVALID_BLOCKS: "ブロックの順序が無効です。",
      INVALID_PARENT_BLOCK: "親ブロックの指定が無効です。",
      INVALID_PARENT_PAGE: "親ページの指定が無効です。",
      unknown: "エラーが発生しました。もう一度お試しください。"
    }
  },

  ko: {
    meta: { description: "BrainVault - 마크다운 블록 기반 노션 스타일 노트앱" },
    language: { label: "언어" },
    sidebar: { aria: "BrainVault 사이드바", homeAria: "BrainVault 홈" },
    brand: { eyebrow: "개인 워크스페이스" },
    auth: {
      loginKicker: "다시 오신 것을 환영합니다",
      registerKicker: "계정 만들기",
      loginTitle: "로그인",
      registerTitle: "회원가입",
      loginDescription: "노트 작성에 바로 집중할 수 있도록 아이디와 비밀번호만 입력하세요.",
      registerDescription: "아이디와 비밀번호로 새 BrainVault 계정을 만드세요.",
      username: "아이디(ID)",
      password: "비밀번호",
      name: "이름",
      optional: "선택",
      namePlaceholder: "Vault Keeper",
      login: "로그인",
      register: "회원가입",
      loginSwitch: "회원이 아니신가요?",
      registerSwitch: "이미 계정이 있으신가요?"
    },
    workspace: { aria: "워크스페이스 탐색", logout: "로그아웃" },
    search: { label: "문서와 블록 검색", placeholder: "문서/블록 검색", button: "검색" },
    navigation: { aria: "기본 컬렉션과 문서 목록" },
    collection: {
      heading: "📁 기본 컬렉션",
      addAria: "기본 컬렉션에 새 문서 추가",
      addTitle: "새 문서 추가",
      description: "+ 를 누르면 제목이 ‘새 문서’인 문서가 바로 만들어집니다."
    },
    home: {
      kicker: "BrainVault 워크스페이스",
      title: "생각을 가볍게 기록하세요.",
      description: "흩어진 아이디어와 해야 할 일을 한곳에 모으세요. 페이지를 만들고, 블록을 쌓고, 필요한 순간 빠르게 다시 찾을 수 있습니다.",
      newPage: "새 페이지 만들기",
      recent: "최근 페이지",
      quickStart: "빠른 시작",
      steps: "3단계",
      guide1Title: "1. 새 페이지 만들기",
      guide1Description: "사이드바의 + 또는 상단 버튼으로 바로 시작하세요.",
      guide2Title: "2. 제목과 태그 정리",
      guide2Description: "페이지의 맥락을 한눈에 알아볼 수 있게 정리하세요.",
      guide3Title: "3. / 로 블록 선택",
      guide3Description: "텍스트, 제목, 할 일, 표, 코드 블록을 빠르게 추가하세요."
    },
    page: {
      titleAria: "문서 제목",
      save: "저장",
      archive: "보관하기",
      tags: "태그",
      tagsPlaceholder: "태그를 쉼표로 구분해 입력",
      content: "페이지 콘텐츠",
      editorHelp: "<kbd>Enter</kbd>로 새 블록 · <kbd>Shift</kbd> + <kbd>Enter</kbd>로 줄바꿈 · 빈 블록에서 <kbd>Backspace</kbd>로 삭제",
      editorAria: "통합 블록 문서 에디터"
    },
    menu: {
      slashAria: "블록 타입 선택",
      blockAria: "블록 작업",
      addBlock: "블록 추가",
      insertBefore: "상단에 블록 추가",
      insertAfter: "하단에 블록 추가",
      calloutType: "콜아웃 타입",
      saveBlock: "블록 저장",
      deleteBlock: "블록 삭제"
    },
    toolbar: {
      aria: "선택 텍스트 서식",
      bold: "굵게",
      italic: "이탤릭",
      strike: "취소선",
      code: "인라인 코드",
      link: "링크",
      colorDefault: "기본 글자색",
      colorSky: "하늘색 글자",
      colorBlue: "파란색 글자",
      colorRed: "빨간색 글자",
      colorGreen: "초록색 글자"
    },
    blocks: { types: { MARKDOWN: "텍스트", HEADING_1: "제목 1", HEADING_2: "제목 2", HEADING_3: "제목 3", TODO: "할 일", QUOTE: "인용", CALLOUT: "콜아웃", TABLE: "표", CODE: "코드", DIVIDER: "구분선", IMAGE: "이미지" } },
    callouts: { idea: "아이디어", info: "정보", success: "성공", warning: "주의", danger: "위험" },
    slash: {
      MARKDOWN: { label: "텍스트", hint: "일반 마크다운 블록", keywords: "markdown text 문단 텍스트" },
      HEADING_1: { label: "제목 1", hint: "가장 큰 제목", keywords: "heading title 제목 h1" },
      HEADING_2: { label: "제목 2", hint: "중간 제목", keywords: "heading subtitle 제목 h2" },
      HEADING_3: { label: "제목 3", hint: "작은 제목", keywords: "heading 제목 h3" },
      TODO: { label: "체크박스", hint: "할 일 블록", keywords: "todo task check 할일 체크" },
      QUOTE: { label: "인용", hint: "인용문 블록", keywords: "quote 인용" },
      CALLOUT: { label: "콜아웃", hint: "강조 박스", keywords: "callout notice 콜아웃 강조" },
      TABLE: { label: "표", hint: "행과 열을 편집하는 간단한 표", keywords: "table grid 표 테이블" },
      CODE: { label: "코드", hint: "코드 블록", keywords: "code 코드" },
      DIVIDER: { label: "구분선", hint: "가로 구분선", keywords: "divider hr line 구분선" },
      IMAGE: { label: "이미지", hint: "이미지 URL 블록", keywords: "image img 사진 이미지" }
    },
    table: {
      toolbarAria: "표 편집 도구",
      firstRow: "첫 행",
      firstRowTitle: "첫 행을 머리글로 사용",
      firstColumn: "첫 열",
      firstColumnTitle: "첫 열을 머리글로 사용",
      deleteRow: "− 행",
      deleteRowTitle: "선택한 행 삭제",
      deleteColumn: "− 열",
      deleteColumnTitle: "선택한 열 삭제",
      editableAria: "편집 가능한 표",
      cellAria: "{row}행 {column}열",
      addColumn: "표 맨 오른쪽에 열 추가",
      addRow: "표 맨 아래에 행 추가"
    },
    block: {
      dividerPlaceholder: "구분선 블록",
      contentPlaceholder: "내용을 입력하거나 '/'로 블록 타입을 선택하세요",
      contentAria: "{type} 블록 내용",
      handleTitle: "드래그하여 순서 변경 · 클릭하여 블록 메뉴",
      handleAria: "블록 순서 변경 핸들 및 블록 메뉴",
      meta: "블록 · {date}",
      completed: "완료",
      saving: "저장 중",
      saved: "저장됨"
    },
    empty: {
      noSearchResults: "조건에 맞는 문서가 없습니다. 검색어를 바꿔보세요.",
      noDocumentsSidebar: "아직 문서가 없습니다. 기본 컬렉션의 +를 눌러 시작하세요.",
      noDocumentsHome: "아직 문서가 없습니다. 왼쪽 기본 컬렉션의 +를 눌러 시작하세요.",
      preparingBlock: "편집할 첫 블록을 준비하고 있습니다.",
      noSlashResults: "일치하는 블록 타입이 없습니다."
    },
    counts: { documents: "{count}개", blocks: "{count}개" },
    newDocumentTitle: "새 문서",
    position: { top: "상단", bottom: "하단" },
    confirm: { archivePage: "이 문서를 보관할까요? 목록에서 숨겨집니다.", deleteBlock: "이 블록을 삭제할까요?" },
    status: {
      calloutChanged: "콜아웃 타입을 {type}(으)로 변경했습니다.",
      savingBlockOrder: "블록 순서를 저장하는 중입니다...",
      blockOrderChanged: "블록 순서를 변경했습니다.",
      blockSaved: "블록을 저장했습니다.",
      formatApplied: "선택한 텍스트 서식을 적용했습니다.",
      blockInserted: "{position}에 새 블록을 만들었습니다. '/'를 입력해 타입을 선택하세요.",
      blockAppended: "새 블록을 만들었습니다. '/'를 입력해 타입을 선택하세요.",
      emptyBlockDeleted: "빈 블록을 삭제했습니다.",
      pageTitleSaved: "문서 제목을 저장했습니다.",
      creatingDocument: "기본 컬렉션에 새 문서를 만드는 중입니다...",
      documentCreated: "새 문서를 만들었습니다. 제목을 바로 수정하세요.",
      loadingDocument: "문서를 불러오는 중입니다...",
      documentOpened: "문서를 열었습니다.",
      ready: "준비되었습니다.",
      getStarted: "로그인하거나 회원가입해서 시작하세요.",
      loginRequired: "로그인이 필요합니다.",
      registerPrompt: "회원가입 정보를 입력하세요.",
      loginPrompt: "아이디와 비밀번호로 로그인하세요.",
      loggingIn: "로그인 중입니다...",
      registering: "회원가입 중입니다...",
      loggedInAs: "{username} ID로 시작합니다.",
      loggedOut: "로그아웃했습니다.",
      searchLoaded: "검색 결과를 불러왔습니다.",
      collectionOpened: "기본 컬렉션을 열었습니다.",
      pageSaved: "페이지를 저장했습니다.",
      pageArchived: "문서를 보관했습니다.",
      blockDeleted: "블록을 삭제했습니다.",
      languageChanged: "언어를 {language}(으)로 변경했습니다."
    },
    errors: {
      currentBlockOrder: "현재 블록의 순서를 찾을 수 없습니다.",
      network: "서버에 연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도하세요.",
      invalidResponse: "서버 응답을 읽을 수 없습니다.",
      VALIDATION_ERROR: "입력한 내용을 확인하세요.",
      ID_TAKEN: "이미 사용 중인 아이디입니다.",
      INVALID_CREDENTIALS: "아이디 또는 비밀번호가 올바르지 않습니다.",
      INVALID_TOKEN: "로그인 정보가 만료되었거나 올바르지 않습니다. 다시 로그인하세요.",
      UNAUTHENTICATED: "계속하려면 로그인하세요.",
      NOT_FOUND: "요청한 항목을 찾을 수 없습니다.",
      ROUTE_NOT_FOUND: "요청한 API 경로를 찾을 수 없습니다.",
      DATABASE_CONSTRAINT_FAILED: "기존 데이터와 충돌하는 요청입니다.",
      ER_DUP_ENTRY: "이미 존재하는 값입니다.",
      INTERNAL_SERVER_ERROR: "예상하지 못한 서버 오류가 발생했습니다.",
      USER_CREATE_FAILED: "계정을 만들지 못했습니다.",
      BLOCK_CREATE_FAILED: "블록을 만들지 못했습니다.",
      INVALID_BLOCKS: "블록 순서가 올바르지 않습니다.",
      INVALID_PARENT_BLOCK: "상위 블록 지정이 올바르지 않습니다.",
      INVALID_PARENT_PAGE: "상위 페이지 지정이 올바르지 않습니다.",
      unknown: "문제가 발생했습니다. 다시 시도하세요."
    }
  },

  fr: {
    meta: { description: "BrainVault - une application de notes façon Notion basée sur des blocs Markdown" },
    language: { label: "Langue" },
    sidebar: { aria: "Barre latérale BrainVault", homeAria: "Accueil BrainVault" },
    brand: { eyebrow: "Espace de travail privé" },
    auth: {
      loginKicker: "Heureux de vous revoir",
      registerKicker: "Créer un compte",
      loginTitle: "Se connecter",
      registerTitle: "S’inscrire",
      loginDescription: "Saisissez votre identifiant et votre mot de passe pour vous concentrer sur vos notes.",
      registerDescription: "Créez un compte BrainVault avec un identifiant et un mot de passe.",
      username: "Identifiant",
      password: "Mot de passe",
      name: "Nom",
      optional: "Facultatif",
      namePlaceholder: "Vault Keeper",
      login: "Se connecter",
      register: "S’inscrire",
      loginSwitch: "Nouveau sur BrainVault ?",
      registerSwitch: "Vous avez déjà un compte ?"
    },
    workspace: { aria: "Navigation de l’espace de travail", logout: "Se déconnecter" },
    search: { label: "Rechercher des pages et des blocs", placeholder: "Rechercher pages/blocs", button: "Rechercher" },
    navigation: { aria: "Collection par défaut et liste des pages" },
    collection: {
      heading: "📁 Collection par défaut",
      addAria: "Ajouter une page à la collection par défaut",
      addTitle: "Ajouter une page",
      description: "Appuyez sur + pour créer immédiatement une page intitulée « Sans titre »."
    },
    home: {
      kicker: "Espace de travail BrainVault",
      title: "Notez vos idées en toute simplicité.",
      description: "Réunissez vos idées et tâches dispersées au même endroit. Créez des pages, empilez des blocs et retrouvez rapidement ce qu’il vous faut.",
      newPage: "Créer une page",
      recent: "Pages récentes",
      quickStart: "Démarrage rapide",
      steps: "3 étapes",
      guide1Title: "1. Créer une page",
      guide1Description: "Commencez immédiatement avec le + de la barre latérale ou le bouton ci-dessus.",
      guide2Title: "2. Organiser le titre et les tags",
      guide2Description: "Rendez le contexte de chaque page clair au premier coup d’œil.",
      guide3Title: "3. Choisir un bloc avec /",
      guide3Description: "Ajoutez rapidement du texte, des titres, des tâches, des tableaux et du code."
    },
    page: {
      titleAria: "Titre de la page",
      save: "Enregistrer",
      archive: "Archiver",
      tags: "Tags",
      tagsPlaceholder: "Séparez les tags par des virgules",
      content: "Contenu de la page",
      editorHelp: "<kbd>Entrée</kbd> pour un nouveau bloc · <kbd>Maj</kbd> + <kbd>Entrée</kbd> pour un saut de ligne · <kbd>Retour arrière</kbd> sur un bloc vide pour le supprimer",
      editorAria: "Éditeur de document à blocs unifié"
    },
    menu: {
      slashAria: "Choisir le type de bloc",
      blockAria: "Actions du bloc",
      addBlock: "Ajouter un bloc",
      insertBefore: "Ajouter un bloc au-dessus",
      insertAfter: "Ajouter un bloc en dessous",
      calloutType: "Type d’encadré",
      saveBlock: "Enregistrer le bloc",
      deleteBlock: "Supprimer le bloc"
    },
    toolbar: {
      aria: "Mettre en forme le texte sélectionné",
      bold: "Gras",
      italic: "Italique",
      strike: "Barré",
      code: "Code en ligne",
      link: "Lien",
      colorDefault: "Couleur de texte par défaut",
      colorSky: "Texte bleu ciel",
      colorBlue: "Texte bleu",
      colorRed: "Texte rouge",
      colorGreen: "Texte vert"
    },
    blocks: { types: { MARKDOWN: "Texte", HEADING_1: "Titre 1", HEADING_2: "Titre 2", HEADING_3: "Titre 3", TODO: "Tâche", QUOTE: "Citation", CALLOUT: "Encadré", TABLE: "Tableau", CODE: "Code", DIVIDER: "Séparateur", IMAGE: "Image" } },
    callouts: { idea: "Idée", info: "Information", success: "Succès", warning: "Avertissement", danger: "Danger" },
    slash: {
      MARKDOWN: { label: "Texte", hint: "Bloc Markdown standard", keywords: "markdown texte paragraphe" },
      HEADING_1: { label: "Titre 1", hint: "Titre le plus grand", keywords: "heading titre h1" },
      HEADING_2: { label: "Titre 2", hint: "Titre moyen", keywords: "heading sous-titre titre h2" },
      HEADING_3: { label: "Titre 3", hint: "Petit titre", keywords: "heading titre h3" },
      TODO: { label: "Case à cocher", hint: "Bloc de tâche", keywords: "todo tâche case cocher" },
      QUOTE: { label: "Citation", hint: "Bloc de citation", keywords: "quote citation" },
      CALLOUT: { label: "Encadré", hint: "Boîte mise en évidence", keywords: "callout notice encadré surbrillance" },
      TABLE: { label: "Tableau", hint: "Tableau simple avec lignes et colonnes modifiables", keywords: "table grid tableau lignes colonnes" },
      CODE: { label: "Code", hint: "Bloc de code", keywords: "code programmation" },
      DIVIDER: { label: "Séparateur", hint: "Ligne de séparation horizontale", keywords: "divider ligne séparateur" },
      IMAGE: { label: "Image", hint: "Bloc d’image par URL", keywords: "image photo illustration" }
    },
    table: {
      toolbarAria: "Outils d’édition du tableau",
      firstRow: "Première ligne",
      firstRowTitle: "Utiliser la première ligne comme en-tête",
      firstColumn: "Première colonne",
      firstColumnTitle: "Utiliser la première colonne comme en-tête",
      deleteRow: "− Ligne",
      deleteRowTitle: "Supprimer la ligne sélectionnée",
      deleteColumn: "− Colonne",
      deleteColumnTitle: "Supprimer la colonne sélectionnée",
      editableAria: "Tableau modifiable",
      cellAria: "Ligne {row}, colonne {column}",
      addColumn: "Ajouter une colonne à droite du tableau",
      addRow: "Ajouter une ligne en bas du tableau"
    },
    block: {
      dividerPlaceholder: "Bloc séparateur",
      contentPlaceholder: "Saisissez du contenu ou « / » pour choisir un type de bloc",
      contentAria: "Contenu du bloc {type}",
      handleTitle: "Faire glisser pour réordonner · Cliquer pour le menu du bloc",
      handleAria: "Poignée de réorganisation et menu du bloc",
      meta: "Bloc · {date}",
      completed: "Terminé",
      saving: "Enregistrement",
      saved: "Enregistré"
    },
    empty: {
      noSearchResults: "Aucune page ne correspond aux filtres. Essayez une autre recherche.",
      noDocumentsSidebar: "Aucune page pour le moment. Appuyez sur + dans la collection par défaut pour commencer.",
      noDocumentsHome: "Aucune page pour le moment. Appuyez sur + dans la collection par défaut à gauche pour commencer.",
      preparingBlock: "Préparation du premier bloc à modifier.",
      noSlashResults: "Aucun type de bloc correspondant."
    },
    counts: { documents: "{count} pages", blocks: "{count} blocs" },
    newDocumentTitle: "Sans titre",
    position: { top: "au-dessus", bottom: "en dessous" },
    confirm: { archivePage: "Archiver cette page ? Elle sera masquée de la liste.", deleteBlock: "Supprimer ce bloc ?" },
    status: {
      calloutChanged: "Type d’encadré remplacé par « {type} ».",
      savingBlockOrder: "Enregistrement de l’ordre des blocs...",
      blockOrderChanged: "Ordre des blocs mis à jour.",
      blockSaved: "Bloc enregistré.",
      formatApplied: "Mise en forme appliquée au texte sélectionné.",
      blockInserted: "Nouveau bloc créé {position}. Saisissez « / » pour choisir son type.",
      blockAppended: "Nouveau bloc créé. Saisissez « / » pour choisir son type.",
      emptyBlockDeleted: "Bloc vide supprimé.",
      pageTitleSaved: "Titre de la page enregistré.",
      creatingDocument: "Création d’une page dans la collection par défaut...",
      documentCreated: "Page créée. Vous pouvez modifier son titre immédiatement.",
      loadingDocument: "Chargement de la page...",
      documentOpened: "Page ouverte.",
      ready: "Prêt.",
      getStarted: "Connectez-vous ou inscrivez-vous pour commencer.",
      loginRequired: "Veuillez vous connecter.",
      registerPrompt: "Saisissez vos informations d’inscription.",
      loginPrompt: "Connectez-vous avec votre identifiant et votre mot de passe.",
      loggingIn: "Connexion...",
      registering: "Création du compte...",
      loggedInAs: "Démarrage avec l’identifiant {username}.",
      loggedOut: "Déconnecté.",
      searchLoaded: "Résultats de recherche chargés.",
      collectionOpened: "Collection par défaut ouverte.",
      pageSaved: "Page enregistrée.",
      pageArchived: "Page archivée.",
      blockDeleted: "Bloc supprimé.",
      languageChanged: "Langue remplacée par {language}."
    },
    errors: {
      currentBlockOrder: "Impossible de déterminer l’ordre actuel du bloc.",
      network: "Connexion au serveur impossible. Vérifiez votre réseau et réessayez.",
      invalidResponse: "Le serveur a renvoyé une réponse illisible.",
      VALIDATION_ERROR: "Vérifiez les informations saisies.",
      ID_TAKEN: "Cet identifiant est déjà utilisé.",
      INVALID_CREDENTIALS: "L’identifiant ou le mot de passe est incorrect.",
      INVALID_TOKEN: "Votre session est invalide ou expirée. Reconnectez-vous.",
      UNAUTHENTICATED: "Connectez-vous pour continuer.",
      NOT_FOUND: "L’élément demandé est introuvable.",
      ROUTE_NOT_FOUND: "Le point d’accès demandé est introuvable.",
      DATABASE_CONSTRAINT_FAILED: "La demande entre en conflit avec des données existantes.",
      ER_DUP_ENTRY: "Cette valeur existe déjà.",
      INTERNAL_SERVER_ERROR: "Une erreur inattendue du serveur s’est produite.",
      USER_CREATE_FAILED: "Impossible de créer le compte.",
      BLOCK_CREATE_FAILED: "Impossible de créer le bloc.",
      INVALID_BLOCKS: "L’ordre des blocs est invalide.",
      INVALID_PARENT_BLOCK: "Le bloc parent sélectionné est invalide.",
      INVALID_PARENT_PAGE: "La page parente sélectionnée est invalide.",
      unknown: "Une erreur s’est produite. Réessayez."
    }
  },

  de: {
    meta: { description: "BrainVault – eine Notion-ähnliche Notiz-App auf Basis von Markdown-Blöcken" },
    language: { label: "Sprache" },
    sidebar: { aria: "BrainVault-Seitenleiste", homeAria: "BrainVault-Startseite" },
    brand: { eyebrow: "Privater Arbeitsbereich" },
    auth: {
      loginKicker: "Willkommen zurück",
      registerKicker: "Konto erstellen",
      loginTitle: "Anmelden",
      registerTitle: "Registrieren",
      loginDescription: "Gib deine ID und dein Passwort ein, damit du dich direkt aufs Schreiben konzentrieren kannst.",
      registerDescription: "Erstelle mit einer ID und einem Passwort ein neues BrainVault-Konto.",
      username: "ID",
      password: "Passwort",
      name: "Name",
      optional: "Optional",
      namePlaceholder: "Vault Keeper",
      login: "Anmelden",
      register: "Registrieren",
      loginSwitch: "Neu bei BrainVault?",
      registerSwitch: "Du hast bereits ein Konto?"
    },
    workspace: { aria: "Arbeitsbereich-Navigation", logout: "Abmelden" },
    search: { label: "Seiten und Blöcke durchsuchen", placeholder: "Seiten/Blöcke suchen", button: "Suchen" },
    navigation: { aria: "Standardsammlung und Seitenliste" },
    collection: {
      heading: "📁 Standardsammlung",
      addAria: "Neue Seite zur Standardsammlung hinzufügen",
      addTitle: "Neue Seite hinzufügen",
      description: "Drücke +, um sofort eine Seite mit dem Titel „Unbenannt“ zu erstellen."
    },
    home: {
      kicker: "BrainVault-Arbeitsbereich",
      title: "Halte deine Gedanken mühelos fest.",
      description: "Sammle verstreute Ideen und Aufgaben an einem Ort. Erstelle Seiten, füge Blöcke hinzu und finde alles schnell wieder.",
      newPage: "Neue Seite erstellen",
      recent: "Letzte Seiten",
      quickStart: "Schnellstart",
      steps: "3 Schritte",
      guide1Title: "1. Neue Seite erstellen",
      guide1Description: "Starte sofort über das + in der Seitenleiste oder die Schaltfläche oben.",
      guide2Title: "2. Titel und Tags ordnen",
      guide2Description: "Mach den Kontext jeder Seite auf einen Blick verständlich.",
      guide3Title: "3. Block mit / auswählen",
      guide3Description: "Füge schnell Text, Überschriften, Aufgaben, Tabellen und Codeblöcke hinzu."
    },
    page: {
      titleAria: "Seitentitel",
      save: "Speichern",
      archive: "Archivieren",
      tags: "Tags",
      tagsPlaceholder: "Tags durch Kommas trennen",
      content: "Seiteninhalt",
      editorHelp: "<kbd>Eingabe</kbd> für einen neuen Block · <kbd>Umschalt</kbd> + <kbd>Eingabe</kbd> für einen Zeilenumbruch · <kbd>Rücktaste</kbd> in einem leeren Block zum Löschen",
      editorAria: "Einheitlicher Block-Dokumenteditor"
    },
    menu: {
      slashAria: "Blocktyp auswählen",
      blockAria: "Blockaktionen",
      addBlock: "Block hinzufügen",
      insertBefore: "Block darüber hinzufügen",
      insertAfter: "Block darunter hinzufügen",
      calloutType: "Hinweis-Typ",
      saveBlock: "Block speichern",
      deleteBlock: "Block löschen"
    },
    toolbar: {
      aria: "Ausgewählten Text formatieren",
      bold: "Fett",
      italic: "Kursiv",
      strike: "Durchgestrichen",
      code: "Inline-Code",
      link: "Link",
      colorDefault: "Standard-Textfarbe",
      colorSky: "Hellblauer Text",
      colorBlue: "Blauer Text",
      colorRed: "Roter Text",
      colorGreen: "Grüner Text"
    },
    blocks: { types: { MARKDOWN: "Text", HEADING_1: "Überschrift 1", HEADING_2: "Überschrift 2", HEADING_3: "Überschrift 3", TODO: "Aufgabe", QUOTE: "Zitat", CALLOUT: "Hinweis", TABLE: "Tabelle", CODE: "Code", DIVIDER: "Trennlinie", IMAGE: "Bild" } },
    callouts: { idea: "Idee", info: "Information", success: "Erfolg", warning: "Warnung", danger: "Gefahr" },
    slash: {
      MARKDOWN: { label: "Text", hint: "Normaler Markdown-Block", keywords: "markdown text absatz" },
      HEADING_1: { label: "Überschrift 1", hint: "Größte Überschrift", keywords: "heading titel überschrift h1" },
      HEADING_2: { label: "Überschrift 2", hint: "Mittlere Überschrift", keywords: "heading untertitel überschrift h2" },
      HEADING_3: { label: "Überschrift 3", hint: "Kleine Überschrift", keywords: "heading überschrift h3" },
      TODO: { label: "Kontrollkästchen", hint: "Aufgabenblock", keywords: "todo aufgabe check kontrollkästchen" },
      QUOTE: { label: "Zitat", hint: "Zitatblock", keywords: "quote zitat" },
      CALLOUT: { label: "Hinweis", hint: "Hervorgehobener Kasten", keywords: "callout notice hinweis hervorhebung" },
      TABLE: { label: "Tabelle", hint: "Einfache bearbeitbare Zeilen und Spalten", keywords: "table grid tabelle zeilen spalten" },
      CODE: { label: "Code", hint: "Codeblock", keywords: "code programmierung" },
      DIVIDER: { label: "Trennlinie", hint: "Horizontale Trennlinie", keywords: "divider hr line trennlinie" },
      IMAGE: { label: "Bild", hint: "Bild-URL-Block", keywords: "image img foto bild" }
    },
    table: {
      toolbarAria: "Werkzeuge zur Tabellenbearbeitung",
      firstRow: "Erste Zeile",
      firstRowTitle: "Erste Zeile als Kopfzeile verwenden",
      firstColumn: "Erste Spalte",
      firstColumnTitle: "Erste Spalte als Kopfspalte verwenden",
      deleteRow: "− Zeile",
      deleteRowTitle: "Ausgewählte Zeile löschen",
      deleteColumn: "− Spalte",
      deleteColumnTitle: "Ausgewählte Spalte löschen",
      editableAria: "Bearbeitbare Tabelle",
      cellAria: "Zeile {row}, Spalte {column}",
      addColumn: "Spalte rechts an die Tabelle anfügen",
      addRow: "Zeile unten an die Tabelle anfügen"
    },
    block: {
      dividerPlaceholder: "Trennlinienblock",
      contentPlaceholder: "Inhalt eingeben oder mit „/“ einen Blocktyp auswählen",
      contentAria: "Inhalt des Blocks {type}",
      handleTitle: "Zum Sortieren ziehen · Für Blockmenü klicken",
      handleAria: "Griff zum Sortieren und Blockmenü",
      meta: "Block · {date}",
      completed: "Erledigt",
      saving: "Wird gespeichert",
      saved: "Gespeichert"
    },
    empty: {
      noSearchResults: "Keine Seiten entsprechen den Filtern. Versuche eine andere Suche.",
      noDocumentsSidebar: "Noch keine Seiten. Drücke + in der Standardsammlung, um zu beginnen.",
      noDocumentsHome: "Noch keine Seiten. Drücke links in der Standardsammlung auf +, um zu beginnen.",
      preparingBlock: "Der erste Block wird zur Bearbeitung vorbereitet.",
      noSlashResults: "Keine passenden Blocktypen."
    },
    counts: { documents: "{count} Seiten", blocks: "{count} Blöcke" },
    newDocumentTitle: "Unbenannt",
    position: { top: "darüber", bottom: "darunter" },
    confirm: { archivePage: "Diese Seite archivieren? Sie wird aus der Liste ausgeblendet.", deleteBlock: "Diesen Block löschen?" },
    status: {
      calloutChanged: "Hinweis-Typ zu „{type}“ geändert.",
      savingBlockOrder: "Blockreihenfolge wird gespeichert...",
      blockOrderChanged: "Blockreihenfolge aktualisiert.",
      blockSaved: "Block gespeichert.",
      formatApplied: "Formatierung auf den ausgewählten Text angewendet.",
      blockInserted: "Neuen Block {position} erstellt. Gib „/“ ein, um den Typ auszuwählen.",
      blockAppended: "Neuen Block erstellt. Gib „/“ ein, um den Typ auszuwählen.",
      emptyBlockDeleted: "Leeren Block gelöscht.",
      pageTitleSaved: "Seitentitel gespeichert.",
      creatingDocument: "Seite wird in der Standardsammlung erstellt...",
      documentCreated: "Seite erstellt. Du kannst den Titel jetzt bearbeiten.",
      loadingDocument: "Seite wird geladen...",
      documentOpened: "Seite geöffnet.",
      ready: "Bereit.",
      getStarted: "Melde dich an oder registriere dich, um zu beginnen.",
      loginRequired: "Bitte anmelden.",
      registerPrompt: "Gib deine Registrierungsdaten ein.",
      loginPrompt: "Melde dich mit ID und Passwort an.",
      loggingIn: "Anmeldung läuft...",
      registering: "Konto wird erstellt...",
      loggedInAs: "Start mit ID {username}.",
      loggedOut: "Abgemeldet.",
      searchLoaded: "Suchergebnisse geladen.",
      collectionOpened: "Standardsammlung geöffnet.",
      pageSaved: "Seite gespeichert.",
      pageArchived: "Seite archiviert.",
      blockDeleted: "Block gelöscht.",
      languageChanged: "Sprache zu {language} geändert."
    },
    errors: {
      currentBlockOrder: "Die aktuelle Blockreihenfolge konnte nicht ermittelt werden.",
      network: "Keine Verbindung zum Server. Prüfe dein Netzwerk und versuche es erneut.",
      invalidResponse: "Der Server hat eine unlesbare Antwort gesendet.",
      VALIDATION_ERROR: "Bitte prüfe die eingegebenen Daten.",
      ID_TAKEN: "Diese ID wird bereits verwendet.",
      INVALID_CREDENTIALS: "ID oder Passwort ist falsch.",
      INVALID_TOKEN: "Deine Sitzung ist ungültig oder abgelaufen. Bitte melde dich erneut an.",
      UNAUTHENTICATED: "Bitte melde dich an, um fortzufahren.",
      NOT_FOUND: "Das angeforderte Element wurde nicht gefunden.",
      ROUTE_NOT_FOUND: "Der angeforderte Endpunkt wurde nicht gefunden.",
      DATABASE_CONSTRAINT_FAILED: "Die Anfrage steht im Konflikt mit vorhandenen Daten.",
      ER_DUP_ENTRY: "Dieser Wert ist bereits vorhanden.",
      INTERNAL_SERVER_ERROR: "Ein unerwarteter Serverfehler ist aufgetreten.",
      USER_CREATE_FAILED: "Das Konto konnte nicht erstellt werden.",
      BLOCK_CREATE_FAILED: "Der Block konnte nicht erstellt werden.",
      INVALID_BLOCKS: "Die Blockreihenfolge ist ungültig.",
      INVALID_PARENT_BLOCK: "Der ausgewählte übergeordnete Block ist ungültig.",
      INVALID_PARENT_PAGE: "Die ausgewählte übergeordnete Seite ist ungültig.",
      unknown: "Etwas ist schiefgelaufen. Bitte versuche es erneut."
    }
  },

  es: {
    meta: { description: "BrainVault: una aplicación de notas estilo Notion basada en bloques Markdown" },
    language: { label: "Idioma" },
    sidebar: { aria: "Barra lateral de BrainVault", homeAria: "Inicio de BrainVault" },
    brand: { eyebrow: "Espacio de trabajo privado" },
    auth: {
      loginKicker: "Te damos la bienvenida",
      registerKicker: "Crear una cuenta",
      loginTitle: "Iniciar sesión",
      registerTitle: "Registrarse",
      loginDescription: "Introduce tu ID y contraseña para centrarte directamente en tus notas.",
      registerDescription: "Crea una cuenta de BrainVault con un ID y una contraseña.",
      username: "ID",
      password: "Contraseña",
      name: "Nombre",
      optional: "Opcional",
      namePlaceholder: "Vault Keeper",
      login: "Iniciar sesión",
      register: "Registrarse",
      loginSwitch: "¿Eres nuevo en BrainVault?",
      registerSwitch: "¿Ya tienes una cuenta?"
    },
    workspace: { aria: "Navegación del espacio de trabajo", logout: "Cerrar sesión" },
    search: { label: "Buscar páginas y bloques", placeholder: "Buscar páginas/bloques", button: "Buscar" },
    navigation: { aria: "Colección predeterminada y lista de páginas" },
    collection: {
      heading: "📁 Colección predeterminada",
      addAria: "Añadir una página a la colección predeterminada",
      addTitle: "Añadir página",
      description: "Pulsa + para crear al instante una página titulada «Sin título»."
    },
    home: {
      kicker: "Espacio de trabajo de BrainVault",
      title: "Anota tus ideas con facilidad.",
      description: "Reúne ideas y tareas dispersas en un solo lugar. Crea páginas, añade bloques y encuentra lo que necesitas en segundos.",
      newPage: "Crear página",
      recent: "Páginas recientes",
      quickStart: "Inicio rápido",
      steps: "3 pasos",
      guide1Title: "1. Crear una página",
      guide1Description: "Empieza al instante con el + de la barra lateral o el botón superior.",
      guide2Title: "2. Organizar el título y las etiquetas",
      guide2Description: "Haz que el contexto de cada página se entienda de un vistazo.",
      guide3Title: "3. Elegir un bloque con /",
      guide3Description: "Añade rápidamente texto, títulos, tareas, tablas y bloques de código."
    },
    page: {
      titleAria: "Título de la página",
      save: "Guardar",
      archive: "Archivar",
      tags: "Etiquetas",
      tagsPlaceholder: "Separa las etiquetas con comas",
      content: "Contenido de la página",
      editorHelp: "<kbd>Intro</kbd> para un bloque nuevo · <kbd>Mayús</kbd> + <kbd>Intro</kbd> para un salto de línea · <kbd>Retroceso</kbd> en un bloque vacío para eliminarlo",
      editorAria: "Editor unificado de documentos por bloques"
    },
    menu: {
      slashAria: "Elegir tipo de bloque",
      blockAria: "Acciones del bloque",
      addBlock: "Añadir bloque",
      insertBefore: "Añadir bloque arriba",
      insertAfter: "Añadir bloque abajo",
      calloutType: "Tipo de aviso",
      saveBlock: "Guardar bloque",
      deleteBlock: "Eliminar bloque"
    },
    toolbar: {
      aria: "Dar formato al texto seleccionado",
      bold: "Negrita",
      italic: "Cursiva",
      strike: "Tachado",
      code: "Código en línea",
      link: "Enlace",
      colorDefault: "Color de texto predeterminado",
      colorSky: "Texto azul cielo",
      colorBlue: "Texto azul",
      colorRed: "Texto rojo",
      colorGreen: "Texto verde"
    },
    blocks: { types: { MARKDOWN: "Texto", HEADING_1: "Título 1", HEADING_2: "Título 2", HEADING_3: "Título 3", TODO: "Tarea", QUOTE: "Cita", CALLOUT: "Aviso", TABLE: "Tabla", CODE: "Código", DIVIDER: "Separador", IMAGE: "Imagen" } },
    callouts: { idea: "Idea", info: "Información", success: "Éxito", warning: "Advertencia", danger: "Peligro" },
    slash: {
      MARKDOWN: { label: "Texto", hint: "Bloque Markdown normal", keywords: "markdown texto párrafo" },
      HEADING_1: { label: "Título 1", hint: "Título más grande", keywords: "heading título h1" },
      HEADING_2: { label: "Título 2", hint: "Título mediano", keywords: "heading subtítulo título h2" },
      HEADING_3: { label: "Título 3", hint: "Título pequeño", keywords: "heading título h3" },
      TODO: { label: "Casilla", hint: "Bloque de tarea", keywords: "todo tarea check casilla" },
      QUOTE: { label: "Cita", hint: "Bloque de cita", keywords: "quote cita" },
      CALLOUT: { label: "Aviso", hint: "Cuadro destacado", keywords: "callout notice aviso destacado" },
      TABLE: { label: "Tabla", hint: "Filas y columnas editables", keywords: "table grid tabla filas columnas" },
      CODE: { label: "Código", hint: "Bloque de código", keywords: "code código programación" },
      DIVIDER: { label: "Separador", hint: "Separador horizontal", keywords: "divider línea separador" },
      IMAGE: { label: "Imagen", hint: "Bloque de imagen mediante URL", keywords: "image img foto imagen" }
    },
    table: {
      toolbarAria: "Herramientas de edición de tabla",
      firstRow: "Primera fila",
      firstRowTitle: "Usar la primera fila como encabezado",
      firstColumn: "Primera columna",
      firstColumnTitle: "Usar la primera columna como encabezado",
      deleteRow: "− Fila",
      deleteRowTitle: "Eliminar la fila seleccionada",
      deleteColumn: "− Columna",
      deleteColumnTitle: "Eliminar la columna seleccionada",
      editableAria: "Tabla editable",
      cellAria: "Fila {row}, columna {column}",
      addColumn: "Añadir una columna al borde derecho de la tabla",
      addRow: "Añadir una fila al final de la tabla"
    },
    block: {
      dividerPlaceholder: "Bloque separador",
      contentPlaceholder: "Escribe contenido o usa «/» para elegir un tipo de bloque",
      contentAria: "Contenido del bloque {type}",
      handleTitle: "Arrastrar para reordenar · Pulsar para abrir el menú del bloque",
      handleAria: "Control de reordenación y menú del bloque",
      meta: "Bloque · {date}",
      completed: "Hecho",
      saving: "Guardando",
      saved: "Guardado"
    },
    empty: {
      noSearchResults: "Ninguna página coincide con los filtros. Prueba otra búsqueda.",
      noDocumentsSidebar: "Aún no hay páginas. Pulsa + en la colección predeterminada para empezar.",
      noDocumentsHome: "Aún no hay páginas. Pulsa + en la colección predeterminada de la izquierda para empezar.",
      preparingBlock: "Preparando el primer bloque para editar.",
      noSlashResults: "No hay tipos de bloque coincidentes."
    },
    counts: { documents: "{count} páginas", blocks: "{count} bloques" },
    newDocumentTitle: "Sin título",
    position: { top: "arriba", bottom: "abajo" },
    confirm: { archivePage: "¿Archivar esta página? Se ocultará de la lista.", deleteBlock: "¿Eliminar este bloque?" },
    status: {
      calloutChanged: "El tipo de aviso se cambió a «{type}».",
      savingBlockOrder: "Guardando el orden de los bloques...",
      blockOrderChanged: "Orden de bloques actualizado.",
      blockSaved: "Bloque guardado.",
      formatApplied: "Formato aplicado al texto seleccionado.",
      blockInserted: "Se creó un bloque nuevo {position}. Escribe «/» para elegir su tipo.",
      blockAppended: "Se creó un bloque nuevo. Escribe «/» para elegir su tipo.",
      emptyBlockDeleted: "Bloque vacío eliminado.",
      pageTitleSaved: "Título de la página guardado.",
      creatingDocument: "Creando una página en la colección predeterminada...",
      documentCreated: "Página creada. Ya puedes editar el título.",
      loadingDocument: "Cargando página...",
      documentOpened: "Página abierta.",
      ready: "Listo.",
      getStarted: "Inicia sesión o regístrate para empezar.",
      loginRequired: "Inicia sesión.",
      registerPrompt: "Introduce tus datos de registro.",
      loginPrompt: "Inicia sesión con tu ID y contraseña.",
      loggingIn: "Iniciando sesión...",
      registering: "Creando la cuenta...",
      loggedInAs: "Iniciando con el ID {username}.",
      loggedOut: "Sesión cerrada.",
      searchLoaded: "Resultados de búsqueda cargados.",
      collectionOpened: "Colección predeterminada abierta.",
      pageSaved: "Página guardada.",
      pageArchived: "Página archivada.",
      blockDeleted: "Bloque eliminado.",
      languageChanged: "Idioma cambiado a {language}."
    },
    errors: {
      currentBlockOrder: "No se pudo determinar el orden actual del bloque.",
      network: "No se pudo conectar con el servidor. Revisa la red e inténtalo de nuevo.",
      invalidResponse: "El servidor devolvió una respuesta ilegible.",
      VALIDATION_ERROR: "Revisa la información introducida.",
      ID_TAKEN: "Ese ID ya está en uso.",
      INVALID_CREDENTIALS: "El ID o la contraseña no son correctos.",
      INVALID_TOKEN: "Tu sesión no es válida o ha caducado. Vuelve a iniciar sesión.",
      UNAUTHENTICATED: "Inicia sesión para continuar.",
      NOT_FOUND: "No se encontró el elemento solicitado.",
      ROUTE_NOT_FOUND: "No se encontró el endpoint solicitado.",
      DATABASE_CONSTRAINT_FAILED: "La solicitud entra en conflicto con datos existentes.",
      ER_DUP_ENTRY: "Ese valor ya existe.",
      INTERNAL_SERVER_ERROR: "Se produjo un error inesperado del servidor.",
      USER_CREATE_FAILED: "No se pudo crear la cuenta.",
      BLOCK_CREATE_FAILED: "No se pudo crear el bloque.",
      INVALID_BLOCKS: "El orden de los bloques no es válido.",
      INVALID_PARENT_BLOCK: "El bloque principal seleccionado no es válido.",
      INVALID_PARENT_PAGE: "La página principal seleccionada no es válida.",
      unknown: "Algo salió mal. Inténtalo de nuevo."
    }
  },

  pt: {
    meta: { description: "BrainVault — um aplicativo de notas no estilo Notion baseado em blocos Markdown" },
    language: { label: "Idioma" },
    sidebar: { aria: "Barra lateral do BrainVault", homeAria: "Início do BrainVault" },
    brand: { eyebrow: "Espaço de trabalho privado" },
    auth: {
      loginKicker: "Boas-vindas de volta",
      registerKicker: "Criar conta",
      loginTitle: "Entrar",
      registerTitle: "Cadastrar-se",
      loginDescription: "Digite seu ID e sua senha para se concentrar diretamente nas anotações.",
      registerDescription: "Crie uma nova conta do BrainVault com um ID e uma senha.",
      username: "ID",
      password: "Senha",
      name: "Nome",
      optional: "Opcional",
      namePlaceholder: "Vault Keeper",
      login: "Entrar",
      register: "Cadastrar-se",
      loginSwitch: "Novo no BrainVault?",
      registerSwitch: "Já tem uma conta?"
    },
    workspace: { aria: "Navegação do espaço de trabalho", logout: "Sair" },
    search: { label: "Pesquisar páginas e blocos", placeholder: "Pesquisar páginas/blocos", button: "Pesquisar" },
    navigation: { aria: "Coleção padrão e lista de páginas" },
    collection: {
      heading: "📁 Coleção padrão",
      addAria: "Adicionar uma página à coleção padrão",
      addTitle: "Adicionar página",
      description: "Pressione + para criar imediatamente uma página chamada “Sem título”."
    },
    home: {
      kicker: "Espaço de trabalho do BrainVault",
      title: "Registre suas ideias com leveza.",
      description: "Reúna ideias e tarefas espalhadas em um só lugar. Crie páginas, empilhe blocos e encontre rapidamente o que precisa.",
      newPage: "Criar página",
      recent: "Páginas recentes",
      quickStart: "Início rápido",
      steps: "3 etapas",
      guide1Title: "1. Criar uma página",
      guide1Description: "Comece na hora com o + da barra lateral ou o botão acima.",
      guide2Title: "2. Organizar o título e as tags",
      guide2Description: "Deixe o contexto de cada página claro de relance.",
      guide3Title: "3. Escolher um bloco com /",
      guide3Description: "Adicione rapidamente texto, títulos, tarefas, tabelas e blocos de código."
    },
    page: {
      titleAria: "Título da página",
      save: "Salvar",
      archive: "Arquivar",
      tags: "Tags",
      tagsPlaceholder: "Separe as tags com vírgulas",
      content: "Conteúdo da página",
      editorHelp: "<kbd>Enter</kbd> para um novo bloco · <kbd>Shift</kbd> + <kbd>Enter</kbd> para quebrar a linha · <kbd>Backspace</kbd> em um bloco vazio para excluí-lo",
      editorAria: "Editor unificado de documentos em blocos"
    },
    menu: {
      slashAria: "Escolher tipo de bloco",
      blockAria: "Ações do bloco",
      addBlock: "Adicionar bloco",
      insertBefore: "Adicionar bloco acima",
      insertAfter: "Adicionar bloco abaixo",
      calloutType: "Tipo de destaque",
      saveBlock: "Salvar bloco",
      deleteBlock: "Excluir bloco"
    },
    toolbar: {
      aria: "Formatar o texto selecionado",
      bold: "Negrito",
      italic: "Itálico",
      strike: "Tachado",
      code: "Código embutido",
      link: "Link",
      colorDefault: "Cor de texto padrão",
      colorSky: "Texto azul-claro",
      colorBlue: "Texto azul",
      colorRed: "Texto vermelho",
      colorGreen: "Texto verde"
    },
    blocks: { types: { MARKDOWN: "Texto", HEADING_1: "Título 1", HEADING_2: "Título 2", HEADING_3: "Título 3", TODO: "Tarefa", QUOTE: "Citação", CALLOUT: "Destaque", TABLE: "Tabela", CODE: "Código", DIVIDER: "Divisor", IMAGE: "Imagem" } },
    callouts: { idea: "Ideia", info: "Informação", success: "Sucesso", warning: "Aviso", danger: "Perigo" },
    slash: {
      MARKDOWN: { label: "Texto", hint: "Bloco Markdown comum", keywords: "markdown texto parágrafo" },
      HEADING_1: { label: "Título 1", hint: "Maior título", keywords: "heading título h1" },
      HEADING_2: { label: "Título 2", hint: "Título médio", keywords: "heading subtítulo título h2" },
      HEADING_3: { label: "Título 3", hint: "Título pequeno", keywords: "heading título h3" },
      TODO: { label: "Caixa de seleção", hint: "Bloco de tarefa", keywords: "todo tarefa check caixa seleção" },
      QUOTE: { label: "Citação", hint: "Bloco de citação", keywords: "quote citação" },
      CALLOUT: { label: "Destaque", hint: "Caixa em destaque", keywords: "callout notice destaque aviso" },
      TABLE: { label: "Tabela", hint: "Linhas e colunas editáveis", keywords: "table grid tabela linhas colunas" },
      CODE: { label: "Código", hint: "Bloco de código", keywords: "code código programação" },
      DIVIDER: { label: "Divisor", hint: "Divisor horizontal", keywords: "divider hr linha divisor" },
      IMAGE: { label: "Imagem", hint: "Bloco de imagem por URL", keywords: "image img foto imagem" }
    },
    table: {
      toolbarAria: "Ferramentas de edição de tabela",
      firstRow: "Primeira linha",
      firstRowTitle: "Usar a primeira linha como cabeçalho",
      firstColumn: "Primeira coluna",
      firstColumnTitle: "Usar a primeira coluna como cabeçalho",
      deleteRow: "− Linha",
      deleteRowTitle: "Excluir a linha selecionada",
      deleteColumn: "− Coluna",
      deleteColumnTitle: "Excluir a coluna selecionada",
      editableAria: "Tabela editável",
      cellAria: "Linha {row}, coluna {column}",
      addColumn: "Adicionar uma coluna à direita da tabela",
      addRow: "Adicionar uma linha ao fim da tabela"
    },
    block: {
      dividerPlaceholder: "Bloco divisor",
      contentPlaceholder: "Digite o conteúdo ou use “/” para escolher um tipo de bloco",
      contentAria: "Conteúdo do bloco {type}",
      handleTitle: "Arraste para reordenar · Clique para abrir o menu do bloco",
      handleAria: "Alça de reordenação e menu do bloco",
      meta: "Bloco · {date}",
      completed: "Concluído",
      saving: "Salvando",
      saved: "Salvo"
    },
    empty: {
      noSearchResults: "Nenhuma página corresponde aos filtros. Tente outra pesquisa.",
      noDocumentsSidebar: "Ainda não há páginas. Pressione + na coleção padrão para começar.",
      noDocumentsHome: "Ainda não há páginas. Pressione + na coleção padrão à esquerda para começar.",
      preparingBlock: "Preparando o primeiro bloco para edição.",
      noSlashResults: "Nenhum tipo de bloco correspondente."
    },
    counts: { documents: "{count} páginas", blocks: "{count} blocos" },
    newDocumentTitle: "Sem título",
    position: { top: "acima", bottom: "abaixo" },
    confirm: { archivePage: "Arquivar esta página? Ela ficará oculta na lista.", deleteBlock: "Excluir este bloco?" },
    status: {
      calloutChanged: "Tipo de destaque alterado para “{type}”.",
      savingBlockOrder: "Salvando a ordem dos blocos...",
      blockOrderChanged: "Ordem dos blocos atualizada.",
      blockSaved: "Bloco salvo.",
      formatApplied: "Formatação aplicada ao texto selecionado.",
      blockInserted: "Novo bloco criado {position}. Digite “/” para escolher o tipo.",
      blockAppended: "Novo bloco criado. Digite “/” para escolher o tipo.",
      emptyBlockDeleted: "Bloco vazio excluído.",
      pageTitleSaved: "Título da página salvo.",
      creatingDocument: "Criando uma página na coleção padrão...",
      documentCreated: "Página criada. Você já pode editar o título.",
      loadingDocument: "Carregando página...",
      documentOpened: "Página aberta.",
      ready: "Pronto.",
      getStarted: "Entre ou cadastre-se para começar.",
      loginRequired: "Entre para continuar.",
      registerPrompt: "Digite seus dados de cadastro.",
      loginPrompt: "Entre com seu ID e sua senha.",
      loggingIn: "Entrando...",
      registering: "Criando a conta...",
      loggedInAs: "Iniciando com o ID {username}.",
      loggedOut: "Sessão encerrada.",
      searchLoaded: "Resultados da pesquisa carregados.",
      collectionOpened: "Coleção padrão aberta.",
      pageSaved: "Página salva.",
      pageArchived: "Página arquivada.",
      blockDeleted: "Bloco excluído.",
      languageChanged: "Idioma alterado para {language}."
    },
    errors: {
      currentBlockOrder: "Não foi possível determinar a ordem atual do bloco.",
      network: "Não foi possível conectar ao servidor. Verifique a rede e tente novamente.",
      invalidResponse: "O servidor retornou uma resposta ilegível.",
      VALIDATION_ERROR: "Verifique as informações digitadas.",
      ID_TAKEN: "Esse ID já está em uso.",
      INVALID_CREDENTIALS: "O ID ou a senha está incorreto.",
      INVALID_TOKEN: "Sua sessão é inválida ou expirou. Entre novamente.",
      UNAUTHENTICATED: "Entre para continuar.",
      NOT_FOUND: "O item solicitado não foi encontrado.",
      ROUTE_NOT_FOUND: "O endpoint solicitado não foi encontrado.",
      DATABASE_CONSTRAINT_FAILED: "A solicitação entra em conflito com dados existentes.",
      ER_DUP_ENTRY: "Esse valor já existe.",
      INTERNAL_SERVER_ERROR: "Ocorreu um erro inesperado no servidor.",
      USER_CREATE_FAILED: "Não foi possível criar a conta.",
      BLOCK_CREATE_FAILED: "Não foi possível criar o bloco.",
      INVALID_BLOCKS: "A ordem dos blocos é inválida.",
      INVALID_PARENT_BLOCK: "O bloco pai selecionado é inválido.",
      INVALID_PARENT_PAGE: "A página pai selecionada é inválida.",
      unknown: "Algo deu errado. Tente novamente."
    }
  }
};

function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage can be unavailable in privacy modes; language still changes for the current session.
  }
}

export function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  const base = value.trim().toLowerCase().replaceAll("_", "-").split("-")[0];
  return supportedLanguageCodes.has(base) ? base : null;
}

export function detectBrowserLanguage(languageList = null) {
  const browserLanguages = languageList ?? globalThis.navigator?.languages ?? [globalThis.navigator?.language];
  for (const candidate of browserLanguages ?? []) {
    const normalized = normalizeLanguage(candidate);
    if (normalized) return normalized;
  }
  return "en";
}

export function hasSavedLanguage() {
  return Boolean(normalizeLanguage(readStorage(languageStorageKey)));
}

export function detectInitialLanguage() {
  return normalizeLanguage(readStorage(languageStorageKey)) ?? detectBrowserLanguage();
}

let currentLanguage = detectInitialLanguage();

function getPath(source, key) {
  return key.split(".").reduce((value, segment) => value?.[segment], source);
}

export function t(key, variables = {}) {
  const value = getPath(translationCatalogs[currentLanguage], key) ?? getPath(translationCatalogs.en, key) ?? key;
  if (typeof value !== "string") return key;
  return value.replace(/\{(\w+)\}/g, (match, name) => (variables[name] === undefined ? match : String(variables[name])));
}

export function getLanguage() {
  return currentLanguage;
}

export function getLocale() {
  return supportedLanguages.find(({ code }) => code === currentLanguage)?.locale ?? "en-US";
}

export function getLanguageLabel(code = currentLanguage) {
  return supportedLanguages.find((language) => language.code === normalizeLanguage(code))?.label ?? code;
}

export function formatNumber(value) {
  return new Intl.NumberFormat(getLocale()).format(value);
}

export function populateLanguageSelect(select) {
  if (typeof HTMLSelectElement === "undefined" || !(select instanceof HTMLSelectElement)) return;
  select.replaceChildren(
    ...supportedLanguages.map(({ code, label }) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = label;
      return option;
    })
  );
  select.value = currentLanguage;
}

export function applyDocumentTranslations(root = globalThis.document) {
  if (!root?.querySelectorAll) return;

  root.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-html]").forEach((element) => {
    element.innerHTML = t(element.dataset.i18nHtml);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
  root.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.setAttribute("title", t(element.dataset.i18nTitle));
  });
  root.querySelectorAll("[data-i18n-content]").forEach((element) => {
    element.setAttribute("content", t(element.dataset.i18nContent));
  });

  if (typeof document !== "undefined") {
    document.documentElement.lang = currentLanguage;
    document.documentElement.dir = "ltr";
    document.documentElement.dataset.language = currentLanguage;
  }
}

export function setLanguage(language, { persist = true } = {}) {
  const nextLanguage = normalizeLanguage(language) ?? "en";
  if (persist) writeStorage(languageStorageKey, nextLanguage);
  if (nextLanguage === currentLanguage) {
    applyDocumentTranslations();
    return currentLanguage;
  }

  currentLanguage = nextLanguage;
  applyDocumentTranslations();
  if (typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") {
    globalThis.dispatchEvent(
      new CustomEvent("brainvault:languagechange", { detail: { language: currentLanguage, locale: getLocale() } })
    );
  }
  return currentLanguage;
}

if (typeof window !== "undefined") {
  window.addEventListener("languagechange", () => {
    if (!hasSavedLanguage()) setLanguage(detectBrowserLanguage(), { persist: false });
  });
}
