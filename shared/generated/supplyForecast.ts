// Generated from shared/supplyForecasts.json. Do not edit directly.
export const ACTIVE_SUPPLY_FORECAST_ID = "supply-2026-08-21-v1" as const;
export const ACTIVE_SUPPLY_FORECAST =
  {
    "id": "supply-2026-08-21-v1",
    "kind": "fixed",
    "rulesVersion": "legacy-28-day-v1",
    "effectiveFrom": "2026-08-21",
    "sourceEvidence": [],
    "profiles": [
      {
        "id": "supply-2026-08-21-v1@fixed",
        "effectiveFrom": "2026-08-21T00:00:00.000Z",
        "effectiveUntil": null,
        "scheduleStatus": "confirmed",
        "expectedGain": {
          "blue": 473.912,
          "purple": 55.808,
          "yellow": 24.736
        }
      }
    ]
  } as const;

export const ACTIVE_SUPPLY_FORECAST_BASE_PROFILE = ACTIVE_SUPPLY_FORECAST.profiles[0];
export const ACTIVE_SUPPLY_FORECAST_BASE_PROFILE_ID = ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.id;

export const SUPPLY_FORECAST_REGISTRY =
  {
    "version": 3,
    "activeForecastId": "supply-2026-08-21-v1",
    "stagingForecastId": "supply-2026-10-15-v3",
    "approvedForecastId": "supply-2026-10-15-v3",
    "forecasts": [
      {
        "id": "supply-2026-08-21-v1",
        "kind": "fixed",
        "rulesVersion": "legacy-28-day-v1",
        "effectiveFrom": "2026-08-21",
        "sourceEvidence": [],
        "profiles": [
          {
            "id": "supply-2026-08-21-v1@fixed",
            "effectiveFrom": "2026-08-21T00:00:00.000Z",
            "effectiveUntil": null,
            "scheduleStatus": "confirmed",
            "expectedGain": {
              "blue": 473.912,
              "purple": 55.808,
              "yellow": 24.736
            }
          }
        ]
      },
      {
        "id": "supply-2026-08-28-v1",
        "kind": "schedule",
        "rulesVersion": "schedule-kit-v2",
        "effectiveFrom": "2026-08-28",
        "sourceEvidence": [
          {
            "source": "naver-board-56",
            "itemId": "7138616",
            "url": "https://game.naver.com/lounge/nikke/board/detail/7138616",
            "publishedAt": "2026-01-02T08:00:33.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 33이 곧 오픈될 예정입니다.",
            "contentHash": "a9ff91ffd82256d73c61135d78ceefa6cfe9996870dc021e80b48e04d45b9cb1"
          },
          {
            "source": "naver-board-56",
            "itemId": "7298679",
            "url": "https://game.naver.com/lounge/nikke/board/detail/7298679",
            "publishedAt": "2026-02-13T08:00:39.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 34가 곧 오픈될 예정입니다.",
            "contentHash": "074409a277cf160f12b82aca2fb1247e983ff2b85db0c68084030a4050ec68d9"
          },
          {
            "source": "naver-board-56",
            "itemId": "7409051",
            "url": "https://game.naver.com/lounge/nikke/board/detail/7409051",
            "publishedAt": "2026-03-13T08:00:32.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 35가 곧 오픈될 예정입니다.",
            "contentHash": "f51d93311359e12b1b97c798f5b03f598fba8c8670b3d2ae4082d86e513ffa92"
          },
          {
            "source": "naver-board-56",
            "itemId": "7576019",
            "url": "https://game.naver.com/lounge/nikke/board/detail/7576019",
            "publishedAt": "2026-04-24T08:00:39.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 36이 곧 오픈될 예정입니다.",
            "contentHash": "fc8449b1c02f6081a86457203afece846d76bf7ec9a25d7f51f32e9f3e5edcc5"
          },
          {
            "source": "naver-board-56",
            "itemId": "7911818",
            "url": "https://game.naver.com/lounge/nikke/board/detail/7911818",
            "publishedAt": "2026-07-10T08:00:35.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 39가 곧 오픈될 예정입니다.",
            "contentHash": "08eee95f5c0820b4478b3dfb67edc569e753331c0783d77991aa26f43122f3ac"
          },
          {
            "source": "naver-board-56",
            "itemId": "8060044",
            "url": "https://game.naver.com/lounge/nikke/board/detail/8060044",
            "publishedAt": "2026-08-14T08:00:42.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 40이 곧 오픈될 예정입니다.",
            "contentHash": "b7641af3bc22e0b34c71422f41371245d181e834c1e2f1fae841884b291f5e75"
          },
          {
            "source": "naver-board-56",
            "itemId": "8080556",
            "url": "https://game.naver.com/lounge/nikke/board/detail/8080556",
            "publishedAt": "2026-08-20T01:00:41.000Z",
            "excerpt": "콜라보 기간 한정 Pick Up 모집 오픈 - 「아마기 유키코」 【콜라보 기간 한정 Pick Up 모집 오픈】 아마기 유키코의 기간 한정 Pick Up 모집이 시작되었습니다.",
            "contentHash": "865b622353b78c5f9aa6a1b615eda68b5e0c906dbac4335170c5a030c18ba915"
          },
          {
            "source": "naver-board-56",
            "itemId": "8031679",
            "url": "https://game.naver.com/lounge/nikke/board/detail/8031679",
            "publishedAt": "2026-08-07T02:30:28.000Z",
            "excerpt": "콜라보 기간 한정 Pick Up 모집 예고 - 「아마기 유키코」 【콜라보 기간 한정 Pick Up 모집 예고】 신규 캐릭터가 곧 등장합니다! 이와 더불어, 콜라보 기간 한정 Pick Up 모집 이벤트가 함께 진행될 예정이니 많이 기대해 주세요! ◆ 콜라보 캐릭터 - 아마기 유키코 ◆ Pick Up 모집 기간 - 8/20(목) 5:00 ~ 9/10(목) 4:59 ※ 「아마기 유키코」는 Pick Up 모집 기간이 종료된 후 일반 모집, 신규 지휘관 전용 모집, 일반 모집(튜토리얼), 소셜 포인트 모집, 몰드 아이템, 마일리지 상점을 통해 획득할 수 없습니다.",
            "contentHash": "b4d7784e5233b5f7a87ceb33b392ea4c6d46a479064bd9486b95a390da651fba"
          }
        ],
        "profiles": [
          {
            "id": "supply-2026-08-28-v1@2026-08-27T20:00:00.000Z",
            "effectiveFrom": "2026-08-27T20:00:00.000Z",
            "effectiveUntil": "2026-08-28T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 350.742793013,
              "purple": 60.720030119,
              "yellow": 22.312579514
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-08-28T20:00:00.000Z",
            "effectiveFrom": "2026-08-28T20:00:00.000Z",
            "effectiveUntil": "2026-08-29T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 341.795393331,
              "purple": 58.705483295,
              "yellow": 21.598371355
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-08-29T20:00:00.000Z",
            "effectiveFrom": "2026-08-29T20:00:00.000Z",
            "effectiveUntil": "2026-08-30T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 332.847993648,
              "purple": 56.690936472,
              "yellow": 20.884163195
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-08-30T20:00:00.000Z",
            "effectiveFrom": "2026-08-30T20:00:00.000Z",
            "effectiveUntil": "2026-08-31T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 323.900593966,
              "purple": 54.676389648,
              "yellow": 20.169955035
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-08-31T20:00:00.000Z",
            "effectiveFrom": "2026-08-31T20:00:00.000Z",
            "effectiveUntil": "2026-09-01T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 314.953194283,
              "purple": 52.661842824,
              "yellow": 19.455746875
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-01T20:00:00.000Z",
            "effectiveFrom": "2026-09-01T20:00:00.000Z",
            "effectiveUntil": "2026-09-02T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 271.005794601,
              "purple": 46.647296001,
              "yellow": 16.741538716
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-02T20:00:00.000Z",
            "effectiveFrom": "2026-09-02T20:00:00.000Z",
            "effectiveUntil": "2026-09-03T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 262.058394919,
              "purple": 44.632749177,
              "yellow": 16.027330556
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-03T20:00:00.000Z",
            "effectiveFrom": "2026-09-03T20:00:00.000Z",
            "effectiveUntil": "2026-09-04T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 253.110995236,
              "purple": 42.618202354,
              "yellow": 15.313122396
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-04T20:00:00.000Z",
            "effectiveFrom": "2026-09-04T20:00:00.000Z",
            "effectiveUntil": "2026-09-05T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 244.163595554,
              "purple": 40.60365553,
              "yellow": 14.598914236
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-05T20:00:00.000Z",
            "effectiveFrom": "2026-09-05T20:00:00.000Z",
            "effectiveUntil": "2026-09-06T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 235.216195871,
              "purple": 38.589108707,
              "yellow": 13.884706077
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-06T20:00:00.000Z",
            "effectiveFrom": "2026-09-06T20:00:00.000Z",
            "effectiveUntil": "2026-09-07T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 226.268796189,
              "purple": 36.574561883,
              "yellow": 13.170497917
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-07T20:00:00.000Z",
            "effectiveFrom": "2026-09-07T20:00:00.000Z",
            "effectiveUntil": "2026-09-08T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 217.321396507,
              "purple": 34.560015059,
              "yellow": 12.456289757
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-08T20:00:00.000Z",
            "effectiveFrom": "2026-09-08T20:00:00.000Z",
            "effectiveUntil": "2026-09-09T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 173.373996824,
              "purple": 28.545468236,
              "yellow": 9.742081597
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-09T20:00:00.000Z",
            "effectiveFrom": "2026-09-09T20:00:00.000Z",
            "effectiveUntil": "2026-09-10T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 164.426597142,
              "purple": 26.530921412,
              "yellow": 9.027873438
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-10T20:00:00.000Z",
            "effectiveFrom": "2026-09-10T20:00:00.000Z",
            "effectiveUntil": "2026-09-11T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 155.479197459,
              "purple": 24.516374589,
              "yellow": 8.313665278
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-11T20:00:00.000Z",
            "effectiveFrom": "2026-09-11T20:00:00.000Z",
            "effectiveUntil": "2026-09-12T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 146.531797777,
              "purple": 22.501827765,
              "yellow": 7.599457118
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-12T20:00:00.000Z",
            "effectiveFrom": "2026-09-12T20:00:00.000Z",
            "effectiveUntil": "2026-09-13T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 137.584398094,
              "purple": 20.487280941,
              "yellow": 6.885248958
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-13T20:00:00.000Z",
            "effectiveFrom": "2026-09-13T20:00:00.000Z",
            "effectiveUntil": "2026-09-14T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 128.636998412,
              "purple": 18.472734118,
              "yellow": 6.171040799
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-14T20:00:00.000Z",
            "effectiveFrom": "2026-09-14T20:00:00.000Z",
            "effectiveUntil": "2026-09-15T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 119.68959873,
              "purple": 16.458187294,
              "yellow": 5.456832639
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-15T20:00:00.000Z",
            "effectiveFrom": "2026-09-15T20:00:00.000Z",
            "effectiveUntil": "2026-09-16T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 93.242199047,
              "purple": 12.443640471,
              "yellow": 3.742624479
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-16T20:00:00.000Z",
            "effectiveFrom": "2026-09-16T20:00:00.000Z",
            "effectiveUntil": "2026-09-17T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 602.879791425,
              "purple": 94.792764237,
              "yellow": 38.283620313
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-17T20:00:00.000Z",
            "effectiveFrom": "2026-09-17T20:00:00.000Z",
            "effectiveUntil": "2026-09-18T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 649.427191108,
              "purple": 100.80731106,
              "yellow": 40.597828473
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-18T20:00:00.000Z",
            "effectiveFrom": "2026-09-18T20:00:00.000Z",
            "effectiveUntil": "2026-09-19T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 596.927191108,
              "purple": 94.80731106,
              "yellow": 37.597828473
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-19T20:00:00.000Z",
            "effectiveFrom": "2026-09-19T20:00:00.000Z",
            "effectiveUntil": "2026-09-20T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 545.979791425,
              "purple": 87.992764237,
              "yellow": 34.483620313
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-20T20:00:00.000Z",
            "effectiveFrom": "2026-09-20T20:00:00.000Z",
            "effectiveUntil": "2026-09-21T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 495.032391743,
              "purple": 81.178217413,
              "yellow": 31.369412153
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-21T20:00:00.000Z",
            "effectiveFrom": "2026-09-21T20:00:00.000Z",
            "effectiveUntil": "2026-09-22T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 444.08499206,
              "purple": 74.36367059,
              "yellow": 28.255203994
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-22T20:00:00.000Z",
            "effectiveFrom": "2026-09-22T20:00:00.000Z",
            "effectiveUntil": "2026-09-23T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 375.637592378,
              "purple": 65.549123766,
              "yellow": 24.140995834
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-23T20:00:00.000Z",
            "effectiveFrom": "2026-09-23T20:00:00.000Z",
            "effectiveUntil": "2026-09-24T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 324.690192696,
              "purple": 58.734576942,
              "yellow": 21.026787674
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-24T20:00:00.000Z",
            "effectiveFrom": "2026-09-24T20:00:00.000Z",
            "effectiveUntil": "2026-09-25T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 315.742793013,
              "purple": 56.720030119,
              "yellow": 20.312579514
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-25T20:00:00.000Z",
            "effectiveFrom": "2026-09-25T20:00:00.000Z",
            "effectiveUntil": "2026-09-26T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 306.795393331,
              "purple": 54.705483295,
              "yellow": 19.598371355
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-26T20:00:00.000Z",
            "effectiveFrom": "2026-09-26T20:00:00.000Z",
            "effectiveUntil": "2026-09-27T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 297.847993648,
              "purple": 52.690936472,
              "yellow": 18.884163195
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-27T20:00:00.000Z",
            "effectiveFrom": "2026-09-27T20:00:00.000Z",
            "effectiveUntil": "2026-09-28T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 288.900593966,
              "purple": 50.676389648,
              "yellow": 18.169955035
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-28T20:00:00.000Z",
            "effectiveFrom": "2026-09-28T20:00:00.000Z",
            "effectiveUntil": "2026-09-29T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 279.953194283,
              "purple": 48.661842824,
              "yellow": 17.455746875
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-29T20:00:00.000Z",
            "effectiveFrom": "2026-09-29T20:00:00.000Z",
            "effectiveUntil": "2026-09-30T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 253.505794601,
              "purple": 44.647296001,
              "yellow": 15.741538716
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-09-30T20:00:00.000Z",
            "effectiveFrom": "2026-09-30T20:00:00.000Z",
            "effectiveUntil": "2026-10-01T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 244.558394919,
              "purple": 42.632749177,
              "yellow": 15.027330556
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-01T20:00:00.000Z",
            "effectiveFrom": "2026-10-01T20:00:00.000Z",
            "effectiveUntil": "2026-10-02T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 235.610995236,
              "purple": 40.618202354,
              "yellow": 14.313122396
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-02T20:00:00.000Z",
            "effectiveFrom": "2026-10-02T20:00:00.000Z",
            "effectiveUntil": "2026-10-03T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 226.663595554,
              "purple": 38.60365553,
              "yellow": 13.598914236
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-03T20:00:00.000Z",
            "effectiveFrom": "2026-10-03T20:00:00.000Z",
            "effectiveUntil": "2026-10-04T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 217.716195871,
              "purple": 36.589108707,
              "yellow": 12.884706077
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-04T20:00:00.000Z",
            "effectiveFrom": "2026-10-04T20:00:00.000Z",
            "effectiveUntil": "2026-10-05T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 208.768796189,
              "purple": 34.574561883,
              "yellow": 12.170497917
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-05T20:00:00.000Z",
            "effectiveFrom": "2026-10-05T20:00:00.000Z",
            "effectiveUntil": "2026-10-06T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 199.821396507,
              "purple": 32.560015059,
              "yellow": 11.456289757
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-06T20:00:00.000Z",
            "effectiveFrom": "2026-10-06T20:00:00.000Z",
            "effectiveUntil": "2026-10-07T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 173.373996824,
              "purple": 28.545468236,
              "yellow": 9.742081597
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-07T20:00:00.000Z",
            "effectiveFrom": "2026-10-07T20:00:00.000Z",
            "effectiveUntil": "2026-10-08T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 164.426597142,
              "purple": 26.530921412,
              "yellow": 9.027873438
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-08T20:00:00.000Z",
            "effectiveFrom": "2026-10-08T20:00:00.000Z",
            "effectiveUntil": "2026-10-09T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 155.479197459,
              "purple": 24.516374589,
              "yellow": 8.313665278
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-09T20:00:00.000Z",
            "effectiveFrom": "2026-10-09T20:00:00.000Z",
            "effectiveUntil": "2026-10-10T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 146.531797777,
              "purple": 22.501827765,
              "yellow": 7.599457118
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-10T20:00:00.000Z",
            "effectiveFrom": "2026-10-10T20:00:00.000Z",
            "effectiveUntil": "2026-10-11T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 137.584398094,
              "purple": 20.487280941,
              "yellow": 6.885248958
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-11T20:00:00.000Z",
            "effectiveFrom": "2026-10-11T20:00:00.000Z",
            "effectiveUntil": "2026-10-12T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 128.636998412,
              "purple": 18.472734118,
              "yellow": 6.171040799
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-12T20:00:00.000Z",
            "effectiveFrom": "2026-10-12T20:00:00.000Z",
            "effectiveUntil": "2026-10-13T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 119.68959873,
              "purple": 16.458187294,
              "yellow": 5.456832639
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-13T20:00:00.000Z",
            "effectiveFrom": "2026-10-13T20:00:00.000Z",
            "effectiveUntil": "2026-10-14T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 93.242199047,
              "purple": 12.443640471,
              "yellow": 3.742624479
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-14T20:00:00.000Z",
            "effectiveFrom": "2026-10-14T20:00:00.000Z",
            "effectiveUntil": "2026-10-15T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 550.379791425,
              "purple": 88.792764237,
              "yellow": 35.283620313
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-15T20:00:00.000Z",
            "effectiveFrom": "2026-10-15T20:00:00.000Z",
            "effectiveUntil": "2026-10-16T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 596.927191108,
              "purple": 94.80731106,
              "yellow": 37.597828473
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-16T20:00:00.000Z",
            "effectiveFrom": "2026-10-16T20:00:00.000Z",
            "effectiveUntil": "2026-10-17T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 596.927191108,
              "purple": 94.80731106,
              "yellow": 37.597828473
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-17T20:00:00.000Z",
            "effectiveFrom": "2026-10-17T20:00:00.000Z",
            "effectiveUntil": "2026-10-18T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 545.979791425,
              "purple": 87.992764237,
              "yellow": 34.483620313
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-18T20:00:00.000Z",
            "effectiveFrom": "2026-10-18T20:00:00.000Z",
            "effectiveUntil": "2026-10-19T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 495.032391743,
              "purple": 81.178217413,
              "yellow": 31.369412153
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-19T20:00:00.000Z",
            "effectiveFrom": "2026-10-19T20:00:00.000Z",
            "effectiveUntil": "2026-10-20T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 444.08499206,
              "purple": 74.36367059,
              "yellow": 28.255203994
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-20T20:00:00.000Z",
            "effectiveFrom": "2026-10-20T20:00:00.000Z",
            "effectiveUntil": "2026-10-21T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 375.637592378,
              "purple": 65.549123766,
              "yellow": 24.140995834
            }
          },
          {
            "id": "supply-2026-08-28-v1@2026-10-21T20:00:00.000Z",
            "effectiveFrom": "2026-10-21T20:00:00.000Z",
            "effectiveUntil": null,
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 324.690192696,
              "purple": 58.734576942,
              "yellow": 21.026787674
            }
          }
        ]
      },
      {
        "id": "supply-2026-10-15-v3",
        "kind": "schedule",
        "rulesVersion": "schedule-kit-v3",
        "effectiveFrom": "2026-10-15",
        "sourceEvidence": [
          {
            "source": "naver-board-56",
            "itemId": "7138616",
            "url": "https://game.naver.com/lounge/nikke/board/detail/7138616",
            "publishedAt": "2026-01-02T08:00:33.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 33이 곧 오픈될 예정입니다.",
            "contentHash": "a9ff91ffd82256d73c61135d78ceefa6cfe9996870dc021e80b48e04d45b9cb1"
          },
          {
            "source": "naver-board-56",
            "itemId": "7298679",
            "url": "https://game.naver.com/lounge/nikke/board/detail/7298679",
            "publishedAt": "2026-02-13T08:00:39.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 34가 곧 오픈될 예정입니다.",
            "contentHash": "074409a277cf160f12b82aca2fb1247e983ff2b85db0c68084030a4050ec68d9"
          },
          {
            "source": "naver-board-56",
            "itemId": "7409051",
            "url": "https://game.naver.com/lounge/nikke/board/detail/7409051",
            "publishedAt": "2026-03-13T08:00:32.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 35가 곧 오픈될 예정입니다.",
            "contentHash": "f51d93311359e12b1b97c798f5b03f598fba8c8670b3d2ae4082d86e513ffa92"
          },
          {
            "source": "naver-board-56",
            "itemId": "7576019",
            "url": "https://game.naver.com/lounge/nikke/board/detail/7576019",
            "publishedAt": "2026-04-24T08:00:39.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 36이 곧 오픈될 예정입니다.",
            "contentHash": "fc8449b1c02f6081a86457203afece846d76bf7ec9a25d7f51f32e9f3e5edcc5"
          },
          {
            "source": "naver-board-56",
            "itemId": "7911818",
            "url": "https://game.naver.com/lounge/nikke/board/detail/7911818",
            "publishedAt": "2026-07-10T08:00:35.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 39가 곧 오픈될 예정입니다.",
            "contentHash": "08eee95f5c0820b4478b3dfb67edc569e753331c0783d77991aa26f43122f3ac"
          },
          {
            "source": "naver-board-56",
            "itemId": "8060044",
            "url": "https://game.naver.com/lounge/nikke/board/detail/8060044",
            "publishedAt": "2026-08-14T08:00:42.000Z",
            "excerpt": "솔로 레이드 오픈 예정 【솔로 레이드 오픈 예정】 ​ 솔로 레이드 시즌 40이 곧 오픈될 예정입니다.",
            "contentHash": "b7641af3bc22e0b34c71422f41371245d181e834c1e2f1fae841884b291f5e75"
          },
          {
            "source": "naver-board-56",
            "itemId": "8080556",
            "url": "https://game.naver.com/lounge/nikke/board/detail/8080556",
            "publishedAt": "2026-08-20T01:00:41.000Z",
            "excerpt": "콜라보 기간 한정 Pick Up 모집 오픈 - 「아마기 유키코」 【콜라보 기간 한정 Pick Up 모집 오픈】 아마기 유키코의 기간 한정 Pick Up 모집이 시작되었습니다.",
            "contentHash": "865b622353b78c5f9aa6a1b615eda68b5e0c906dbac4335170c5a030c18ba915"
          },
          {
            "source": "naver-board-56",
            "itemId": "8031679",
            "url": "https://game.naver.com/lounge/nikke/board/detail/8031679",
            "publishedAt": "2026-08-07T02:30:28.000Z",
            "excerpt": "콜라보 기간 한정 Pick Up 모집 예고 - 「아마기 유키코」 【콜라보 기간 한정 Pick Up 모집 예고】 신규 캐릭터가 곧 등장합니다! 이와 더불어, 콜라보 기간 한정 Pick Up 모집 이벤트가 함께 진행될 예정이니 많이 기대해 주세요! ◆ 콜라보 캐릭터 - 아마기 유키코 ◆ Pick Up 모집 기간 - 8/20(목) 5:00 ~ 9/10(목) 4:59 ※ 「아마기 유키코」는 Pick Up 모집 기간이 종료된 후 일반 모집, 신규 지휘관 전용 모집, 일반 모집(튜토리얼), 소셜 포인트 모집, 몰드 아이템, 마일리지 상점을 통해 획득할 수 없습니다.",
            "contentHash": "b4d7784e5233b5f7a87ceb33b392ea4c6d46a479064bd9486b95a390da651fba"
          }
        ],
        "profiles": [
          {
            "id": "supply-2026-10-15-v3@2026-10-14T20:00:00.000Z",
            "effectiveFrom": "2026-10-14T20:00:00.000Z",
            "effectiveUntil": "2026-10-15T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 177.58145640787436,
              "purple": 39.2128146141895,
              "yellow": 10.083539593460157
            },
            "referenceFrom": "2026-10-14T20:00:00.000Z",
            "referenceUntil": "2026-10-23T20:00:00.000Z",
            "referenceDays": 9
          },
          {
            "id": "supply-2026-10-15-v3@2026-10-15T20:00:00.000Z",
            "effectiveFrom": "2026-10-15T20:00:00.000Z",
            "effectiveUntil": "2026-10-16T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 168.28351680699942,
              "purple": 36.90027965705733,
              "yellow": 9.252035194186806
            },
            "referenceFrom": "2026-10-15T20:00:00.000Z",
            "referenceUntil": "2026-10-23T20:00:00.000Z",
            "referenceDays": 8
          },
          {
            "id": "supply-2026-10-15-v3@2026-10-16T20:00:00.000Z",
            "effectiveFrom": "2026-10-16T20:00:00.000Z",
            "effectiveUntil": "2026-10-17T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 158.9855772061245,
              "purple": 34.58774469992517,
              "yellow": 8.420530794913455
            },
            "referenceFrom": "2026-10-16T20:00:00.000Z",
            "referenceUntil": "2026-10-23T20:00:00.000Z",
            "referenceDays": 7
          },
          {
            "id": "supply-2026-10-15-v3@2026-10-17T20:00:00.000Z",
            "effectiveFrom": "2026-10-17T20:00:00.000Z",
            "effectiveUntil": "2026-10-18T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 149.68763760524956,
              "purple": 32.275209742793,
              "yellow": 7.589026395640105
            },
            "referenceFrom": "2026-10-17T20:00:00.000Z",
            "referenceUntil": "2026-10-23T20:00:00.000Z",
            "referenceDays": 6
          },
          {
            "id": "supply-2026-10-15-v3@2026-10-18T20:00:00.000Z",
            "effectiveFrom": "2026-10-18T20:00:00.000Z",
            "effectiveUntil": "2026-10-19T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 140.38969800437465,
              "purple": 29.962674785660834,
              "yellow": 6.757521996366754
            },
            "referenceFrom": "2026-10-18T20:00:00.000Z",
            "referenceUntil": "2026-10-23T20:00:00.000Z",
            "referenceDays": 5
          },
          {
            "id": "supply-2026-10-15-v3@2026-10-19T20:00:00.000Z",
            "effectiveFrom": "2026-10-19T20:00:00.000Z",
            "effectiveUntil": "2026-10-20T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 131.0917584034997,
              "purple": 27.650139828528665,
              "yellow": 5.926017597093404
            },
            "referenceFrom": "2026-10-19T20:00:00.000Z",
            "referenceUntil": "2026-10-23T20:00:00.000Z",
            "referenceDays": 4
          },
          {
            "id": "supply-2026-10-15-v3@2026-10-20T20:00:00.000Z",
            "effectiveFrom": "2026-10-20T20:00:00.000Z",
            "effectiveUntil": "2026-10-21T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 104.29381880262478,
              "purple": 23.3376048713965,
              "yellow": 4.094513197820053
            },
            "referenceFrom": "2026-10-20T20:00:00.000Z",
            "referenceUntil": "2026-10-23T20:00:00.000Z",
            "referenceDays": 3
          },
          {
            "id": "supply-2026-10-15-v3@2026-10-28T20:00:00.000Z",
            "effectiveFrom": "2026-10-28T20:00:00.000Z",
            "effectiveUntil": "2026-10-29T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 362.7526108201233,
              "purple": 95.58830401403984,
              "yellow": 23.72460118328707
            },
            "referenceFrom": "2026-10-28T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 23
          },
          {
            "id": "supply-2026-10-15-v3@2026-10-29T20:00:00.000Z",
            "effectiveFrom": "2026-10-29T20:00:00.000Z",
            "effectiveUntil": "2026-10-30T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 353.45467121924844,
              "purple": 93.27576905690766,
              "yellow": 22.893096784013718
            },
            "referenceFrom": "2026-10-29T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 22
          },
          {
            "id": "supply-2026-10-15-v3@2026-10-30T20:00:00.000Z",
            "effectiveFrom": "2026-10-30T20:00:00.000Z",
            "effectiveUntil": "2026-10-31T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 344.1567316183735,
              "purple": 90.9632340997755,
              "yellow": 22.06159238474037
            },
            "referenceFrom": "2026-10-30T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 21
          },
          {
            "id": "supply-2026-10-15-v3@2026-10-31T20:00:00.000Z",
            "effectiveFrom": "2026-10-31T20:00:00.000Z",
            "effectiveUntil": "2026-11-01T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 334.85879201749856,
              "purple": 88.65069914264333,
              "yellow": 21.23008798546702
            },
            "referenceFrom": "2026-10-31T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 20
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-01T20:00:00.000Z",
            "effectiveFrom": "2026-11-01T20:00:00.000Z",
            "effectiveUntil": "2026-11-02T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 325.5608524166236,
              "purple": 86.33816418551116,
              "yellow": 20.398583586193666
            },
            "referenceFrom": "2026-11-01T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 19
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-02T20:00:00.000Z",
            "effectiveFrom": "2026-11-02T20:00:00.000Z",
            "effectiveUntil": "2026-11-03T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 316.26291281574873,
              "purple": 84.025629228379,
              "yellow": 19.567079186920317
            },
            "referenceFrom": "2026-11-02T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 18
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-03T20:00:00.000Z",
            "effectiveFrom": "2026-11-03T20:00:00.000Z",
            "effectiveUntil": "2026-11-04T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 289.4649732148738,
              "purple": 79.71309427124683,
              "yellow": 17.735574787646964
            },
            "referenceFrom": "2026-11-03T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 17
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-04T20:00:00.000Z",
            "effectiveFrom": "2026-11-04T20:00:00.000Z",
            "effectiveUntil": "2026-11-05T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 270.16703361399885,
              "purple": 67.40055931411466,
              "yellow": 16.904070388373615
            },
            "referenceFrom": "2026-11-04T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 16
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-05T20:00:00.000Z",
            "effectiveFrom": "2026-11-05T20:00:00.000Z",
            "effectiveUntil": "2026-11-06T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 260.8690940131239,
              "purple": 65.0880243569825,
              "yellow": 16.072565989100262
            },
            "referenceFrom": "2026-11-05T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 15
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-06T20:00:00.000Z",
            "effectiveFrom": "2026-11-06T20:00:00.000Z",
            "effectiveUntil": "2026-11-07T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 251.571154412249,
              "purple": 62.775489399850336,
              "yellow": 15.241061589826913
            },
            "referenceFrom": "2026-11-06T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 14
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-07T20:00:00.000Z",
            "effectiveFrom": "2026-11-07T20:00:00.000Z",
            "effectiveUntil": "2026-11-08T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 242.27321481137406,
              "purple": 60.462954442718164,
              "yellow": 14.409557190553562
            },
            "referenceFrom": "2026-11-07T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 13
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-08T20:00:00.000Z",
            "effectiveFrom": "2026-11-08T20:00:00.000Z",
            "effectiveUntil": "2026-11-09T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 232.97527521049915,
              "purple": 58.150419485586,
              "yellow": 13.57805279128021
            },
            "referenceFrom": "2026-11-08T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 12
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-09T20:00:00.000Z",
            "effectiveFrom": "2026-11-09T20:00:00.000Z",
            "effectiveUntil": "2026-11-10T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 223.6773356096242,
              "purple": 55.837884528453834,
              "yellow": 12.74654839200686
            },
            "referenceFrom": "2026-11-09T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 11
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-10T20:00:00.000Z",
            "effectiveFrom": "2026-11-10T20:00:00.000Z",
            "effectiveUntil": "2026-11-11T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 196.87939600874927,
              "purple": 51.52534957132167,
              "yellow": 10.915043992733509
            },
            "referenceFrom": "2026-11-10T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 10
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-11T20:00:00.000Z",
            "effectiveFrom": "2026-11-11T20:00:00.000Z",
            "effectiveUntil": "2026-11-12T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 177.58145640787436,
              "purple": 39.2128146141895,
              "yellow": 10.083539593460157
            },
            "referenceFrom": "2026-11-11T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 9
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-12T20:00:00.000Z",
            "effectiveFrom": "2026-11-12T20:00:00.000Z",
            "effectiveUntil": "2026-11-13T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 168.28351680699942,
              "purple": 36.90027965705733,
              "yellow": 9.252035194186806
            },
            "referenceFrom": "2026-11-12T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 8
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-13T20:00:00.000Z",
            "effectiveFrom": "2026-11-13T20:00:00.000Z",
            "effectiveUntil": "2026-11-14T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 158.9855772061245,
              "purple": 34.58774469992517,
              "yellow": 8.420530794913455
            },
            "referenceFrom": "2026-11-13T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 7
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-14T20:00:00.000Z",
            "effectiveFrom": "2026-11-14T20:00:00.000Z",
            "effectiveUntil": "2026-11-15T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 149.68763760524956,
              "purple": 32.275209742793,
              "yellow": 7.589026395640105
            },
            "referenceFrom": "2026-11-14T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 6
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-15T20:00:00.000Z",
            "effectiveFrom": "2026-11-15T20:00:00.000Z",
            "effectiveUntil": "2026-11-16T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 140.38969800437465,
              "purple": 29.962674785660834,
              "yellow": 6.757521996366754
            },
            "referenceFrom": "2026-11-15T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 5
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-16T20:00:00.000Z",
            "effectiveFrom": "2026-11-16T20:00:00.000Z",
            "effectiveUntil": "2026-11-17T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 131.0917584034997,
              "purple": 27.650139828528665,
              "yellow": 5.926017597093404
            },
            "referenceFrom": "2026-11-16T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 4
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-17T20:00:00.000Z",
            "effectiveFrom": "2026-11-17T20:00:00.000Z",
            "effectiveUntil": "2026-11-18T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 104.29381880262478,
              "purple": 23.3376048713965,
              "yellow": 4.094513197820053
            },
            "referenceFrom": "2026-11-17T20:00:00.000Z",
            "referenceUntil": "2026-11-20T20:00:00.000Z",
            "referenceDays": 3
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-25T20:00:00.000Z",
            "effectiveFrom": "2026-11-25T20:00:00.000Z",
            "effectiveUntil": "2026-11-26T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 455.33818802624785,
              "purple": 123.776048713965,
              "yellow": 30.545131978200526
            },
            "referenceFrom": "2026-11-25T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 30
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-26T20:00:00.000Z",
            "effectiveFrom": "2026-11-26T20:00:00.000Z",
            "effectiveUntil": "2026-11-27T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 446.0402484253729,
              "purple": 121.46351375683284,
              "yellow": 29.713627578927177
            },
            "referenceFrom": "2026-11-26T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 29
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-27T20:00:00.000Z",
            "effectiveFrom": "2026-11-27T20:00:00.000Z",
            "effectiveUntil": "2026-11-28T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 436.74230882449797,
              "purple": 119.15097879970067,
              "yellow": 28.882123179653824
            },
            "referenceFrom": "2026-11-27T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 28
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-28T20:00:00.000Z",
            "effectiveFrom": "2026-11-28T20:00:00.000Z",
            "effectiveUntil": "2026-11-29T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 427.4443692236231,
              "purple": 116.8384438425685,
              "yellow": 28.050618780380475
            },
            "referenceFrom": "2026-11-28T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 27
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-29T20:00:00.000Z",
            "effectiveFrom": "2026-11-29T20:00:00.000Z",
            "effectiveUntil": "2026-11-30T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 418.14642962274814,
              "purple": 114.52590888543634,
              "yellow": 27.219114381107122
            },
            "referenceFrom": "2026-11-29T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 26
          },
          {
            "id": "supply-2026-10-15-v3@2026-11-30T20:00:00.000Z",
            "effectiveFrom": "2026-11-30T20:00:00.000Z",
            "effectiveUntil": "2026-12-01T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 408.8484900218732,
              "purple": 112.21337392830416,
              "yellow": 26.387609981833773
            },
            "referenceFrom": "2026-11-30T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 25
          },
          {
            "id": "supply-2026-10-15-v3@2026-12-01T20:00:00.000Z",
            "effectiveFrom": "2026-12-01T20:00:00.000Z",
            "effectiveUntil": "2026-12-02T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 382.05055042099826,
              "purple": 107.90083897117199,
              "yellow": 24.55610558256042
            },
            "referenceFrom": "2026-12-01T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 24
          },
          {
            "id": "supply-2026-10-15-v3@2026-12-02T20:00:00.000Z",
            "effectiveFrom": "2026-12-02T20:00:00.000Z",
            "effectiveUntil": "2026-12-03T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 362.7526108201233,
              "purple": 95.58830401403984,
              "yellow": 23.72460118328707
            },
            "referenceFrom": "2026-12-02T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 23
          },
          {
            "id": "supply-2026-10-15-v3@2026-12-03T20:00:00.000Z",
            "effectiveFrom": "2026-12-03T20:00:00.000Z",
            "effectiveUntil": "2026-12-04T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 353.45467121924844,
              "purple": 93.27576905690766,
              "yellow": 22.893096784013718
            },
            "referenceFrom": "2026-12-03T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 22
          },
          {
            "id": "supply-2026-10-15-v3@2026-12-04T20:00:00.000Z",
            "effectiveFrom": "2026-12-04T20:00:00.000Z",
            "effectiveUntil": "2026-12-05T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 344.1567316183735,
              "purple": 90.9632340997755,
              "yellow": 22.06159238474037
            },
            "referenceFrom": "2026-12-04T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 21
          },
          {
            "id": "supply-2026-10-15-v3@2026-12-05T20:00:00.000Z",
            "effectiveFrom": "2026-12-05T20:00:00.000Z",
            "effectiveUntil": "2026-12-06T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 334.85879201749856,
              "purple": 88.65069914264333,
              "yellow": 21.23008798546702
            },
            "referenceFrom": "2026-12-05T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 20
          },
          {
            "id": "supply-2026-10-15-v3@2026-12-06T20:00:00.000Z",
            "effectiveFrom": "2026-12-06T20:00:00.000Z",
            "effectiveUntil": "2026-12-07T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 325.5608524166236,
              "purple": 86.33816418551116,
              "yellow": 20.398583586193666
            },
            "referenceFrom": "2026-12-06T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 19
          },
          {
            "id": "supply-2026-10-15-v3@2026-12-07T20:00:00.000Z",
            "effectiveFrom": "2026-12-07T20:00:00.000Z",
            "effectiveUntil": "2026-12-08T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 316.26291281574873,
              "purple": 84.025629228379,
              "yellow": 19.567079186920317
            },
            "referenceFrom": "2026-12-07T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 18
          },
          {
            "id": "supply-2026-10-15-v3@2026-12-08T20:00:00.000Z",
            "effectiveFrom": "2026-12-08T20:00:00.000Z",
            "effectiveUntil": "2026-12-09T20:00:00.000Z",
            "scheduleStatus": "estimated",
            "expectedGain": {
              "blue": 289.4649732148738,
              "purple": 79.71309427124683,
              "yellow": 17.735574787646964
            },
            "referenceFrom": "2026-12-08T20:00:00.000Z",
            "referenceUntil": "2026-12-25T20:00:00.000Z",
            "referenceDays": 17
          }
        ]
      }
    ]
  } as const;

// Acceptance only; never used to select or calculate a forecast.
const COMPAT_IDENTITIES = {
  "sourceCommit": "32982fa9155180440e5a9b686caa5d9efe5e6fde",
  "sha256": "f15758dc4290733ec011d1bdb5179dc4b9f15bda6f195700af3aa09f20515edf",
  "forecastId": "supply-2026-10-15-v3",
  "profileIds": [
    "supply-2026-10-15-v3@2026-10-14T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-10-15T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-10-16T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-10-17T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-10-18T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-10-19T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-10-20T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-10-28T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-10-29T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-10-30T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-10-31T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-01T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-02T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-03T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-04T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-05T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-06T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-07T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-08T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-09T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-10T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-11T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-12T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-13T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-14T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-15T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-16T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-17T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-25T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-26T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-27T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-28T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-29T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-11-30T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-12-01T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-12-02T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-12-03T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-12-04T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-12-05T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-12-06T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-12-07T20:00:00.000Z",
    "supply-2026-10-15-v3@2026-12-08T20:00:00.000Z"
  ]
} as const;

export type SupplyForecastId = (typeof SUPPLY_FORECAST_REGISTRY.forecasts)[number]["id"] | typeof COMPAT_IDENTITIES.forecastId;
export type SupplyForecastProfile = {
  id: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  scheduleStatus: "confirmed" | "estimated";
  expectedGain: { blue: number; purple: number; yellow: number };
  referenceFrom?: string | undefined;
  referenceUntil?: string | undefined;
  referenceDays?: number | undefined;
};

export function isSupplyForecastId(value: unknown): value is SupplyForecastId {
  if (value === COMPAT_IDENTITIES.forecastId) return true;
  return (SUPPLY_FORECAST_REGISTRY.forecasts as readonly { id: string }[]).some(
    (forecast) => forecast.id === value,
  );
}

export function isSupplyForecastProfileId(value: unknown): value is string {
  if (COMPAT_IDENTITIES.profileIds.some((id) => id === value)) return true;
  return SUPPLY_FORECAST_REGISTRY.forecasts.some((forecast) =>
    forecast.profiles.some((profile) => profile.id === value),
  );
}

export function resolveSupplyForecastProfile(
  forecastId: string,
  timestampMs = Date.now(),
): SupplyForecastProfile | null {
  const forecast = SUPPLY_FORECAST_REGISTRY.forecasts.find((entry) => entry.id === forecastId);
  if (!forecast) return null;
  return (forecast.profiles as readonly SupplyForecastProfile[]).find((profile) => {
    const from = Date.parse(profile.effectiveFrom);
    const until = profile.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(profile.effectiveUntil);
    return timestampMs >= from && timestampMs < until;
  }) ?? null;
}

function resolveProfileInForecast(
  forecast: { profiles: readonly SupplyForecastProfile[] },
  timestampMs: number,
): SupplyForecastProfile | null {
  return forecast.profiles.find((profile) => {
    const from = Date.parse(profile.effectiveFrom);
    const until = profile.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(profile.effectiveUntil);
    return timestampMs >= from && timestampMs < until;
  }) ?? null;
}

export function resolveActiveSupplyForecastProfile(
  timestampMs = Date.now(),
): SupplyForecastProfile {
  const profile = resolveProfileInForecast(ACTIVE_SUPPLY_FORECAST, timestampMs);
  if (!profile) throw new Error("The active supply forecast has no profile for the requested time.");
  return profile;
}
