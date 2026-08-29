const browserAPI = typeof browser !== "undefined" ? browser : chrome;

// 크롬: 사이드 패널 API. 툴바 아이콘 클릭 시 사이드 패널이 열리도록 설정.
if (browserAPI.sidePanel) {
  browserAPI.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// 파이어폭스: sidebarAction API. 팝업이 없으므로 아이콘 클릭 시 onClicked가 발생 -> 사이드바 토글.
if (browserAPI.sidebarAction) {
  browserAPI.action.onClicked.addListener(() => {
    browserAPI.sidebarAction.toggle();
  });
}
