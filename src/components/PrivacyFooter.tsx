const footerText = (
  <>
    서비스 개선과 대성공 통계를 위해 계산 조건과 결과를 구간값으로 집계합니다. 이름, 이메일, 계정,
    IP 주소 등 고유 식별 정보는 통계 DB에 저장하지 않습니다.
  </>
);

export default function PrivacyFooter() {
  return (
    <footer className="privacy-footer mt-auto w-full pt-6 text-muted text-[11px] font-normal leading-[1.55] max-mobile:pt-5">
      {footerText}
    </footer>
  );
}
