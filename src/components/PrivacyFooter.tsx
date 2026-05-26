type PrivacyFooterProps = {
  placement?: "desktop" | "mobileStats";
};

const footerText = (
  <>
    이 사이트는 서비스 개선과 대성공 통계 제공을 위해 소장품 등급, 레벨, 경험치, 추천 키트, 추천
    횟수, 대성공 여부, 보유 키트 수정 결과, 접속 유입 도메인, 브라우저/OS/기기 유형, 익명 계산
    진단값을 통계로 수집합니다.
    <br />봇 방지와 과도한 요청 차단을 위해 Cloudflare Turnstile 및 IP 기반 요청 제한을 사용합니다.
    이름, 이메일, 계정 정보 등 직접 식별 정보는 수집하지 않습니다.
  </>
);

export default function PrivacyFooter({ placement = "desktop" }: PrivacyFooterProps) {
  const className =
    placement === "mobileStats"
      ? "mx-[10px] mb-[88px] mt-3 hidden w-auto text-muted text-[11px] font-normal leading-[1.55] opacity-70 max-[660px]:block"
      : "mx-auto mb-7 mt-[-20px] w-[min(1320px,calc(100%_-_32px))] text-muted text-[11px] font-normal leading-[1.55] opacity-70 max-[660px]:hidden";

  return <footer className={className}>{footerText}</footer>;
}
