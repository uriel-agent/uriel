{
  description = "Uriel local-first NixOS coding and QA worker";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs =
    {
      self,
      nixpkgs,
      systems,
      ...
    }:
    let
      eachSystem = nixpkgs.lib.genAttrs (import systems);
    in
    {
      nixosModules.uriel-worker = import ./nix/modules/uriel-worker.nix self;
      homeManagerModules.uriel = import ./nix/modules/home-manager.nix self;

      packages = eachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config = {
              allowUnfree = true;
              android_sdk.accept_license = true;
            };
          };

          mkNodeApp =
            {
              name,
              entrypoint,
            }:
            pkgs.stdenvNoCC.mkDerivation {
              pname = name;
              version = "0.1.0";
              src = self;
              nativeBuildInputs = [
                pkgs.esbuild
                pkgs.makeWrapper
              ];
              buildPhase = ''
                runHook preBuild
                esbuild ${entrypoint} \
                  --bundle \
                  --platform=node \
                  --format=esm \
                  --outfile=${name}.mjs
                runHook postBuild
              '';
              installPhase = ''
                runHook preInstall
                mkdir -p $out/bin $out/lib/${name}
                cp ${name}.mjs $out/lib/${name}/${name}.mjs
                makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/${name} \
                  --add-flags $out/lib/${name}/${name}.mjs
                runHook postInstall
              '';
            };
        in
        {
          default = self.packages.${system}.uriel-worker;
          uriel-worker = mkNodeApp {
            name = "uriel-worker";
            entrypoint = "apps/worker/src/main.ts";
          };
          urielctl = mkNodeApp {
            name = "urielctl";
            entrypoint = "apps/cli/src/main.ts";
          };
        }
      );

      apps = eachSystem (system: {
        default = self.apps.${system}.uriel-worker;
        uriel-worker = {
          type = "app";
          program = "${self.packages.${system}.uriel-worker}/bin/uriel-worker";
        };
        urielctl = {
          type = "app";
          program = "${self.packages.${system}.urielctl}/bin/urielctl";
        };
      });

      devShells = eachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config = {
              allowUnfree = true;
              android_sdk.accept_license = true;
            };
          };
        in
        {
          default = pkgs.mkShellNoCC {
            packages = with pkgs; [
              nodejs_22
              pnpm
              esbuild
              git
              gh
              jq
              just
              nixfmt
            ];
          };
        }
      );

      checks = eachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };
        in
        {
          uriel-worker-package = self.packages.${system}.uriel-worker;
          urielctl-package = self.packages.${system}.urielctl;
          nixfmt = pkgs.runCommand "uriel-nixfmt-check" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
            cd ${self}
            nixfmt --check flake.nix nix/modules/*.nix examples/*/*.nix
            touch $out
          '';
        }
      );
    };
}
