from pathlib import Path
import hashlib
root=Path(__file__).parent
objects={}
def uid(s): return hashlib.sha1(s.encode()).hexdigest()[:24].upper()
def add(name,body): objects[uid(name)]=body;return uid(name)
def q(s): return '"'+s+'"'
files=[];build=[];resources=[];testfiles=[];testres=[]
for folder in ['Fotoro','FotoroTests']:
 for p in sorted((root/folder).rglob('*')):
  if not p.is_file() or p.suffix in [".plist",".entitlements"]:continue
  rel=str(p.relative_to(root)); typ='sourcecode.swift' if p.suffix=='.swift' else 'text.json' if p.suffix=='.json' else 'image.jpeg'
  f=add(rel,f'isa = PBXFileReference; lastKnownFileType = {typ}; path = {q(rel)}; sourceTree = SOURCE_ROOT;');files.append(f)
  b=add(rel+'build',f'isa = PBXBuildFile; fileRef = {f};')
  (testfiles if folder=='FotoroTests' and p.suffix=='.swift' else testres if folder=='FotoroTests' else build if p.suffix=='.swift' else resources).append(b)
products=[]; targets=[]
packages=[];deps=[]
for name,url,version in [('Sodium','https://github.com/jedisct1/swift-sodium.git','0.9.1'),('GRDB','https://github.com/groue/GRDB.swift.git','7.0.0'),('Nuke','https://github.com/kean/Nuke.git','12.8.0')]:
 ref=add(name+'pkg',f'isa = XCRemoteSwiftPackageReference; repositoryURL = {q(url)}; requirement = {{kind = upToNextMajorVersion; minimumVersion = {version};}};');packages.append(ref)
 for product in ([name,'NukeUI'] if name=='Nuke' else [name]):
  dep=add(product+'dep',f'isa = XCSwiftPackageProductDependency; package = {ref}; productName = {product};');deps.append(dep)
frameworks=[add(d+'build',f'isa = PBXBuildFile; productRef = {d};') for d in deps]
for target,sources,res,ptype in [('Fotoro',build,resources,'application'),('FotoroTests',testfiles,testres,'bundle.unit-test')]:
 prod=add(target+'product',f'isa = PBXFileReference; explicitFileType = wrapper.{"application" if target=="Fotoro" else "cfbundle"}; path = {target}.{"app" if target=="Fotoro" else "xctest"}; sourceTree = BUILT_PRODUCTS_DIR;');products.append(prod)
 phases=[]
 for kind,items in [('Sources',sources),('Resources',res),('Frameworks',frameworks if target=='Fotoro' else [])]:phases.append(add(target+kind,f'isa = PBX{kind}BuildPhase; buildActionMask = 2147483647; files = ({",".join(items)}); runOnlyForDeploymentPostprocessing = 0;'))
 configs=[]
 for conf in ['Debug','Release']:
  settings='SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 26.0; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; GENERATE_INFOPLIST_FILE = YES; CODE_SIGN_STYLE = Automatic; PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = cloud.fotoro.'+target+'; '
  settings+='ENABLE_TESTABILITY = YES; ONLY_ACTIVE_ARCH = YES; SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG; SWIFT_OPTIMIZATION_LEVEL = "-Onone"; ' if conf=='Debug' else ''
  settings+='INFOPLIST_KEY_NSPhotoLibraryUsageDescription = "Select original photos to import into Fotoro."; INFOPLIST_FILE = Fotoro/Info.plist; CODE_SIGN_ENTITLEMENTS = Fotoro/Fotoro.entitlements; INFOPLIST_KEY_UILaunchScreen_Generation = YES; ' if target=='Fotoro' else 'TEST_HOST = "$(BUILT_PRODUCTS_DIR)/Fotoro.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/Fotoro"; BUNDLE_LOADER = "$(TEST_HOST)"; '
  configs.append(add(target+conf,f'isa = XCBuildConfiguration; name = {conf}; buildSettings = {{{settings}}};'))
 cl=add(target+'configs',f'isa = XCConfigurationList; buildConfigurations = ({",".join(configs)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
 dependency=[]
 if target=='FotoroTests':
  proxy=add('proxy',f'isa = PBXContainerItemProxy; containerPortal = {uid("project")}; proxyType = 1; remoteGlobalIDString = {uid("FotoroTarget")}; remoteInfo = Fotoro;')
  dependency=[add('dependency',f'isa = PBXTargetDependency; target = {uid("FotoroTarget")}; targetProxy = {proxy};')]
 targets.append(add(target+'Target',f'isa = PBXNativeTarget; buildConfigurationList = {cl}; buildPhases = ({",".join(phases)}); buildRules = (); dependencies = ({",".join(dependency)}); name = {target}; productName = {target}; productReference = {prod}; productType = "com.apple.product-type.{ptype}"; packageProductDependencies = ({",".join(deps) if target=="Fotoro" else ""});'))
pg=add('products',f'isa = PBXGroup; children = ({",".join(products)}); name = Products; sourceTree = "<group>";')
group=add('group',f'isa = PBXGroup; children = ({",".join(files+[pg])}); sourceTree = "<group>";')
configs=[add('project'+c,f'isa = XCBuildConfiguration; name = {c}; buildSettings = {{CLANG_ENABLE_MODULES = YES;}};') for c in ['Debug','Release']]
cl=add('projectconfigs',f'isa = XCConfigurationList; buildConfigurations = ({",".join(configs)}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
proj=add('project',f'isa = PBXProject; attributes = {{LastUpgradeCheck = 2700;}}; buildConfigurationList = {cl}; compatibilityVersion = "Xcode 15.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en,Base); mainGroup = {group}; productRefGroup = {pg}; projectDirPath = ""; projectRoot = ""; targets = ({",".join(targets)}); packageReferences = ({",".join(packages)});')
p=root/'Fotoro.xcodeproj';p.mkdir(exist_ok=True)
(p/'project.pbxproj').write_text('// !$*UTF8*$!\n{archiveVersion = 1; classes = {}; objectVersion = 60; objects = {\n'+''.join(k+' = {'+v+'};\n' for k,v in objects.items())+'}; rootObject = '+proj+';}')
s=p/'xcshareddata/xcschemes';s.mkdir(parents=True,exist_ok=True)
ref=lambda t:f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid(t+"Target")}" BuildableName="{t}.{"app" if t=="Fotoro" else "xctest"}" BlueprintName="{t}" ReferencedContainer="container:Fotoro.xcodeproj"/>'
(s/'Fotoro.xcscheme').write_text(f'<Scheme LastUpgradeVersion="2700" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref("Fotoro")}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug"><Testables><TestableReference skipped="NO">{ref("FotoroTests")}</TestableReference></Testables></TestAction><LaunchAction buildConfiguration="Debug" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref("Fotoro")}</BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release"><BuildableProductRunnable runnableDebuggingMode="0">{ref("Fotoro")}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>')
