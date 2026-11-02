# SPS 문서 분류와 설계 기준

갱신: 2026-11-02. 현재 제품 목표는 [Core 계약](SPS-CORE-CONTRACT.md)과
사용자가 재확인한 [Core–Plugin 원문](https://github.com/Powerpunch777/SPS-Source/blob/codex/sps-core-final-validation/sps-server/docs/design/CORE-PLUGIN-ARCHITECTURE-2026-10-25.md)을 따른다.
README를 제외한 설계 문서를 정렬하는 작업이며 코드·DB·API·테스트·설치본·
사용자 데이터 또는 중단된 장기목표를 변경하지 않는다.

## 우선순위

사용자 최신 결정 > Core–Plugin 원문 > SPS Core 계약 > 분야별 기술 설계 >
날짜/리비전별 구현·시험 기록 > upstream Paperclip 참고 문서다.
README는 이번 범위에서 변경하지 않았으므로 이전 요약과 충돌하면 위 기준을 따른다.
API 이름·manifest 예시는 실제 코드/공개 SDK가 지원하는 범위만 사용한다.

## 제품 경계

- Core는 인증·Workspace·Host/Node·범용 실행/저장/Event/Job·생명주기·보안·복구다.
- Plugin은 업무/역할/승인/기억/협업과 UI다. AI·Agent·Task·Room·Dashboard·Inbox는 필수가 아니다.
- 빈 Workspace, Primary0~1, Extension 다중을 허용한다. Primary는 권한 등급이 아니다.
- Plugin은 전체 UI/창/헤드리스를 선택한다. Core 메뉴·Settings 버튼 삽입을 강제하지 않는다.
- 독립 Native 트레이·단축키·관리/복구, 다중 창·백그라운드 수명주기가 목표다.
- Workspace pause/stop 상태와 실행 소유권을 보존하며 resume이 과거 취소 작업을 재생하지 않는다.
- 최대 파일 범위는 선택적이고 CLI/스크립트/자식까지 집행한다. 전체 파일 허용에도 Vault 원문은 보호한다.
- 현재 같은 사용자 Worker·Source/grant·DPAPI·Job은 전체 OS 보호의 완료 증거가 아니다.
- 자원 관찰은 강제 CPU/RAM 상한이나 고부하 자동 중지와 다르다.
- Workspace+Plugin 초기화·기본 인증정보 제외 백업·사용자 업데이트 적용이 목표다.
- 공개 범용 Builder/공통 Preview는 선택형이며 외부 IDE/다른 Builder 이용을 막지 않는다.
- 별도 Builder의 Lead3/CTO/Dev/QA/GitHub Runner는 그 워크플로의 설계이지 Core 역할이 아니다.
- Marketplace/검사·배지는 별도 후속 단계다. 구체적인 Builder/Preview 라이선스·판매 계약은 미확정이다.
- Core 비공개·SDK 공개는 유지한다. 목표를 문서화해도 미지원 API/실제 보안 제약을 우회하지 않는다.

## 분류

1. `SPS-CORE-CONTRACT.md`, `DESIGN.md`, `ROADMAP.md`: 현행 목표와 구현 간극을 구분한다.
2. `doc/SPS-*.md`: 특정 리비전의 기술 계약/검증이다. 전체 목표를 축소하거나 완료 처리하지 않는다.
3. `doc/plans`, `doc/design`, `doc/spec`, `docs/plans`, `docs/specs` 및 과거 PRODUCT/SPEC/Task/회사/UI 설계:
   호환성·이전 연구 참고다. Paperclip의 Company/Issue/조직도를 SPS 필수 모델로 만들지 않는다.
4. SDK/adapter/API 명세: 실제 기존 구현의 기술 참고다. 공개 API 또는 제품 필수성의 새 보장을 만들지 않는다.
5. 테스트 로그·리뷰·릴리스 기록: 당시 커밋의 사실을 보존한다. 실패·미확인·다른 후보를 현재 통과로 바꾸지 않는다.
6. README·라이선스·법적 고지·실행 코드·스킬 및 실제 사용 매뉴얼은 이번 설계 정렬의 변경 대상이 아니다.

현재 Core 프레임 강제, 일반 단일 Workspace 창, 독립 관리 기능, OS 보호,
일부 데이터 운영/자원 귀속에는 공백이 있다. 이 문서는 그 구현을 완료하지 않는다.
